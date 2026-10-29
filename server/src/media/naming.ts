/**
 * Files PodSovereign makes from an episode's audio (Auphonic's results, an MP3 with chapters written
 * in) keep the uploaded file's exact name: ru053.mp3 is stored as ru053.mp3, with ru053.srt, ru053.vtt
 * and so on. A newer version replaces the file at the same address (the old cached copy is then cleared
 * from the CDN, see cdn/purge.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { maybeOne, one, type Db, type Queryable } from '../db/db.js';
import { activeStore, storeFor } from '../storage/store.js';
import { mediaPath } from '../urls.js';

export class NameTakenError extends Error {
  readonly status = 409;
}

/** "a1b2c3d4-ru053.mp3" → "ru053" (the 8-character prefix uploads get is dropped). */
export function stemOf(filename: string): string {
  return filename.replace(/^[0-9a-f]{8}-/, '').replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
}

/** The stem for a stored media file: its original name, else its address. */
export const mediaStem = (m: { original_name: string | null; public_path: string }) => stemOf(m.original_name ?? path.basename(m.public_path));

const sha256Of = (file: string) => new Promise<string>((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

/** The title of another episode (or "the show") whose content points at this file, if any. */
async function usedElsewhere(q: Queryable, podcastId: string, publicPath: string, episodeId: string): Promise<string | null> {
  const ep = await maybeOne<{ title: string }>(
    q,
    `SELECT title FROM episodes WHERE podcast_id = $1 AND id <> $3 AND (
        position($2 in coalesce(enclosure_url, '')) > 0 OR position($2 in coalesce(itunes_image_url, '')) > 0
     OR position($2 in coalesce(description, '')) > 0
     OR EXISTS (SELECT 1 FROM tag_elements t WHERE t.episode_id = episodes.id AND (
          position($2 in t.attributes::text) > 0 OR position($2 in coalesce(t.children::text, '')) > 0 OR position($2 in coalesce(t.value, '')) > 0)))
     LIMIT 1`,
    [podcastId, publicPath, episodeId],
  );
  if (ep) return `the episode “${ep.title}”`;
  const show = await maybeOne(
    q,
    `SELECT 1 FROM podcasts WHERE id = $1 AND (position($2 in coalesce(image_url, '')) > 0 OR position($2 in coalesce(description, '')) > 0)
     UNION ALL SELECT 1 FROM tag_elements WHERE podcast_id = $1 AND episode_id IS NULL AND (
          position($2 in attributes::text) > 0 OR position($2 in coalesce(children::text, '')) > 0 OR position($2 in coalesce(value, '')) > 0)
     LIMIT 1`,
    [podcastId, publicPath],
  );
  return show ? 'the show' : null;
}

/** Refuse early (before any work) when another episode or the show already uses <dir>/<name>. */
export async function checkNameFree(q: Queryable, podcastId: string, episodeId: string, slug: string, dir: string, name: string): Promise<void> {
  const publicPath = mediaPath(slug, dir, name);
  if (!(await maybeOne(q, `SELECT 1 FROM media_files WHERE public_path = $1`, [publicPath]))) return;
  const other = await usedElsewhere(q, podcastId, publicPath, episodeId);
  if (other) throw new NameTakenError(`${name} is already used by ${other}. Rename the upload (each episode needs its own file name), then try again.`);
}

interface Row { id: string; storage_key: string | null; storage_path: string | null; storage_provider: string | null; public_path: string; original_name: string | null }

/**
 * Move a stored file to a new, prefixed address (keeping its id), so its old address can take a new file.
 * Used for an episode's kept original when it already has the exact name the processed file needs.
 */
async function relocate(db: Db, config: Config, row: Row, slug: string, dir: string, name: string): Promise<void> {
  const staging = path.join(path.resolve(config.mediaDir), '.staging');
  await mkdir(staging, { recursive: true });
  const tmp = path.join(staging, `${randomBytes(8).toString('hex')}-${name}`);
  try {
    const from = storeFor(config, row.storage_provider ?? 'local');
    await from.getToFile(row.storage_key ?? row.public_path.slice(1), tmp);
    const size = (await stat(tmp)).size;
    const publicPath = mediaPath(slug, dir, `${randomBytes(4).toString('hex')}-${name}`);
    const store = activeStore(config);
    const { storagePath } = await store.putFile(publicPath.slice(1), tmp, { size, contentType: 'application/octet-stream' });
    await db.query(`UPDATE media_files SET public_path = $2, storage_key = $3, storage_path = $4, storage_provider = $5, original_name = coalesce(original_name, $6) WHERE id = $1`,
      [row.id, publicPath, publicPath.slice(1), storagePath, store.id, name]);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * Store a made file for an episode at exactly <dir>/<name>. If a file is already there it's replaced in
 * place (same address and media id) and `replaced` is true. `keep` is a media id that must survive (the
 * episode's original upload kept for reprocessing): if it's the file at that address, it's moved aside first.
 * Refused when another episode or the show uses a file at that address.
 */
export async function storeExact(db: Db, config: Config, o: {
  podcastId: string; episodeId: string; slug: string; dir: string; name: string; file: string;
  kind: string; mime: string; duration?: number | null; keep?: string | null;
}): Promise<{ id: string; publicPath: string; replaced: boolean }> {
  const publicPath = mediaPath(o.slug, o.dir, o.name);
  let existing = await maybeOne<Row>(db, `SELECT id, storage_key, storage_path, storage_provider, public_path, original_name FROM media_files WHERE public_path = $1`, [publicPath]);
  if (existing) {
    const other = await usedElsewhere(db, o.podcastId, publicPath, o.episodeId);
    if (other) throw new NameTakenError(`${o.name} is already used by ${other}. Rename the upload (each episode needs its own file name), then try again.`);
    if (o.keep && existing.id === o.keep) {
      await relocate(db, config, existing, o.slug, o.dir, o.name);
      existing = null;
    }
  }
  const size = (await stat(o.file)).size;
  const sha = await sha256Of(o.file);
  const key = publicPath.slice(1);
  const store = activeStore(config);
  const { storagePath } = await store.putFile(key, o.file, { size, contentType: o.mime, sha256: sha });
  if (existing) {
    // The old copy lives with another provider (media moved since): remove it there.
    if (existing.storage_provider && existing.storage_provider !== store.id && existing.storage_key) {
      await storeFor(config, existing.storage_provider).delete(existing.storage_key).catch(() => {});
    }
    await db.query(
      `UPDATE media_files SET kind = $2, storage_path = $3, mime_type = $4, bytes = $5, sha256 = $6, status = 'done', storage_key = $7,
              storage_provider = $8, duration = $9, original_name = $10 WHERE id = $1`,
      [existing.id, o.kind, storagePath, o.mime, size, sha, key, store.id, o.duration ?? null, o.name],
    );
    return { id: existing.id, publicPath, replaced: true };
  }
  const m = await one<{ id: string }>(
    db,
    `INSERT INTO media_files (podcast_id, kind, storage_path, public_path, mime_type, bytes, sha256, status, storage_key, storage_provider, duration, original_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'done', $8, $9, $10, $11) RETURNING id`,
    [o.podcastId, o.kind, storagePath, publicPath, o.mime, size, sha, key, store.id, o.duration ?? null, o.name],
  );
  return { id: m.id, publicPath, replaced: false };
}
