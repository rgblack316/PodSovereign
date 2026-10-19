/**
 * Switching media storage (e.g. this server → Cloudflare R2, or R2 → Bunny).
 *
 * If there's no media yet, the switch is immediate. Otherwise a background
 * move copies every file to the new store, and only once all of them are
 * there does it switch over: stored links are rewritten to the new public
 * address, and copies on this server's disk are removed. If any file fails,
 * nothing is switched; the old storage keeps serving and the move can be
 * retried. Imports are paused while a move runs.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { maybeOne, one, type Db } from '../db/db.js';
import { loadSiteSettings, mediaBaseFor, rewriteChapterFiles, rewriteMediaBase } from '../site/settings.js';
import { providerById, type StorageSettings } from './providers.js';
import { createStore, type StorageState } from './store.js';

export class MoveError extends Error {}

export interface MoveRow {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  from_state: StorageState;
  to_state: StorageState;
  total: number;
  moved: number;
  failed: number;
  bytes: number;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

/** Settings that identify *where* files are (changing them means moving files). */
const LOCATION_KEYS = ['accountId', 'endpoint', 'region', 'bucket', 'zone', 'hostname'];

export function sameLocation(a: StorageState, b: StorageState): boolean {
  if (a.provider !== b.provider) return false;
  return LOCATION_KEYS.every((k) => (a.settings[k] ?? '') === (b.settings[k] ?? ''));
}

const mediaCount = async (db: Db) =>
  (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM media_files WHERE status = 'done' AND storage_key IS NOT NULL`)).n;

/**
 * Apply new storage settings. Same place (e.g. a rotated key or a new public
 * address): updated in place. Different place with no media: switched now.
 * Otherwise: a background move is queued and returned.
 */
export async function changeStorage(db: Db, config: Config, to: StorageState, userId: string): Promise<{ switched: boolean; move: MoveRow | null }> {
  const from = config.storage;
  const active = await maybeOne(db, `SELECT 1 FROM storage_moves WHERE status IN ('queued', 'running')`);
  if (active) throw new MoveError('A media move is already in progress.');

  if (sameLocation(from, to) || (await mediaCount(db)) === 0) {
    const oldBase = config.mediaBaseUrl;
    const row = await one<Parameters<typeof mediaBaseFor>[1]>(db, `SELECT public_base_url, media_base_url, storage_provider, storage_settings FROM site_settings WHERE id`);
    const newBase = mediaBaseFor(config, { ...row, storage_provider: to.provider, storage_settings: to.settings });
    await db.tx(async (q) => {
      await q.query(
        `UPDATE site_settings SET storage_provider = $1, storage_settings = $2, storage_secret = $3, updated_at = now() WHERE id`,
        [to.provider, JSON.stringify(to.settings), to.secret],
      );
      if (newBase !== oldBase) {
        await rewriteMediaBase(q, oldBase, newBase);
        await q.query(`UPDATE podcasts SET feed_cache_xml = NULL, feed_cache_etag = NULL`);
      }
    });
    await loadSiteSettings(db, config);
    if (newBase !== oldBase) await rewriteChapterFiles(db, config, oldBase, newBase);
    return { switched: true, move: null };
  }

  const running = await maybeOne(db, `SELECT 1 FROM import_jobs WHERE status IN ('queued', 'running')`);
  if (running) throw new MoveError('An import is running. Wait for it to finish, then move the media.');
  const move = await one<MoveRow>(
    db,
    `INSERT INTO storage_moves (from_state, to_state, requested_by) VALUES ($1, $2, $3) RETURNING *`,
    [JSON.stringify(from), JSON.stringify(to), userId],
  );
  return { switched: false, move };
}

export async function latestMove(db: Db): Promise<MoveRow | null> {
  return maybeOne<MoveRow>(db, `SELECT * FROM storage_moves ORDER BY created_at DESC LIMIT 1`);
}

export async function claimMove(db: Db): Promise<MoveRow | null> {
  return maybeOne<MoveRow>(
    db,
    `UPDATE storage_moves SET status = 'running', heartbeat_at = now()
      WHERE id = (SELECT id FROM storage_moves WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
  );
}

interface FileRow {
  id: string;
  storage_key: string;
  storage_provider: string;
  storage_path: string | null;
  mime_type: string | null;
  bytes: number | null;
  sha256: string | null;
}

export async function runMove(deps: { db: Db; config: Config; log?: (m: string) => void }, move: MoveRow): Promise<void> {
  const { db, config } = deps;
  const from = move.from_state;
  const to = move.to_state;
  config.storageMoveFrom = from;
  const target = createStore(config, to);
  const source = createStore(config, from);
  const staging = path.join(config.mediaDir, '.staging');
  await mkdir(staging, { recursive: true });

  const { rows: files } = await db.query<FileRow>(
    `SELECT id, storage_key, storage_provider, storage_path, mime_type, bytes, sha256 FROM media_files
      WHERE status = 'done' AND storage_key IS NOT NULL AND storage_provider = $1`,
    [from.provider],
  );
  await db.query(`UPDATE storage_moves SET total = $2 WHERE id = $1`, [move.id, files.length]);

  let moved = 0;
  let failed = 0;
  let bytes = 0;
  const errors: string[] = [];
  const movedFiles: FileRow[] = [];

  try {
    for (const f of files) {
      const tmp = path.join(staging, `${randomBytes(8).toString('hex')}-${path.basename(f.storage_key)}`);
      try {
        // Copy out of the old store into a staging file (the original stays put until the move succeeds),
        // then hand it to the new store, which uploads it (or files it on disk).
        await source.getToFile(f.storage_key, tmp);
        const info = { size: f.bytes ?? 0, contentType: f.mime_type ?? 'application/octet-stream', sha256: f.sha256 ?? undefined };
        const { storagePath } = await target.putFile(f.storage_key, tmp, info);
        await db.query(`UPDATE media_files SET storage_provider = $2, storage_path = $3 WHERE id = $1`, [f.id, target.id, storagePath]);
        movedFiles.push(f);
        moved++;
        bytes += f.bytes ?? 0;
      } catch (e) {
        failed++;
        if (errors.length < 5) errors.push(`${f.storage_key}: ${(e as Error).message}`);
      } finally {
        await rm(tmp, { force: true });
      }
      await db.query(`UPDATE storage_moves SET moved = $2, failed = $3, bytes = $4, heartbeat_at = now() WHERE id = $1`, [move.id, moved, failed, bytes]);
    }

    if (failed) {
      // Put the moved rows back: nothing switches until every file made it.
      for (const f of movedFiles) {
        await db.query(`UPDATE media_files SET storage_provider = $2, storage_path = $3 WHERE id = $1`, [f.id, f.storage_provider, f.storage_path]);
      }
      throw new MoveError(`${failed} of ${files.length} files couldn't be moved, so storage was not switched. ${errors.join('; ')}`);
    }

    // Everything is at the new store: switch over and rewrite links.
    const oldBase = config.mediaBaseUrl;
    const row = await one<Parameters<typeof mediaBaseFor>[1]>(db, `SELECT public_base_url, media_base_url, storage_provider, storage_settings FROM site_settings WHERE id`);
    const newBase = mediaBaseFor(config, { ...row, storage_provider: to.provider, storage_settings: to.settings as StorageSettings });
    await db.tx(async (q) => {
      await q.query(
        `UPDATE site_settings SET storage_provider = $1, storage_settings = $2, storage_secret = $3, updated_at = now() WHERE id`,
        [to.provider, JSON.stringify(to.settings), to.secret],
      );
      if (newBase !== oldBase) await rewriteMediaBase(q, oldBase, newBase);
      await q.query(`UPDATE podcasts SET feed_cache_xml = NULL, feed_cache_etag = NULL`);
      await q.query(`UPDATE storage_moves SET status = 'done', finished_at = now() WHERE id = $1`, [move.id]);
    });
    await loadSiteSettings(db, config);
    if (newBase !== oldBase) await rewriteChapterFiles(db, config, oldBase, newBase);

    // Free the space on this server once the files are safely elsewhere.
    if (source.isLocal && !target.isLocal) {
      for (const f of movedFiles) await source.delete(f.storage_key).catch(() => {});
    }
    deps.log?.(`storage move ${move.id}: ${moved} files moved to ${providerById(to.provider)?.name ?? to.provider}`);
  } catch (e) {
    await db.query(`UPDATE storage_moves SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [move.id, (e as Error).message]);
    deps.log?.(`storage move ${move.id} failed: ${(e as Error).message}`);
  } finally {
    config.storageMoveFrom = null;
  }
}

