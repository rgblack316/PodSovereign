/**
 * File uploads from the dashboard (or any API client): audio and video for
 * episodes, artwork, transcripts and chapters.
 *
 * Files are sent in chunks of a few megabytes. Cloudflare Tunnel refuses any
 * single request over 100 MB, and chunks let an interrupted upload carry on
 * where it stopped instead of starting over.
 *
 *   POST   /api/podcasts/:id/uploads                {filename, size, type, kind?} → {upload}
 *   PUT    /api/podcasts/:id/uploads/:uid?offset=N  raw bytes (application/octet-stream)
 *   POST   /api/podcasts/:id/uploads/:uid/complete  → {media}
 *
 * Finished files go to the active media store under <slug>/media/<type>/.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { maybeOne, one, type Db, type Queryable } from '../db/db.js';
import { isUuid } from '../db/podcasts.js';
import type { MediaKind } from '../feed/media.js';
import { KIND_DIRS } from '../import/importer.js';
import { activeStore } from '../storage/store.js';
import { mediaPath } from '../urls.js';
import { probeFile } from './probe.js';
import { readId3Chapters } from './id3.js';
import { pruneMedia } from './prune.js';

export const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const SMALL_MAX = 20 * 1024 * 1024; // images, transcripts
const CHAPTERS_MAX = 5 * 1024 * 1024;

export class UploadError extends Error {
  constructor(message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** File types accepted for each kind. The extension decides the type, since browsers often send none. */
const TYPES: Record<string, { kind: MediaKind; mime: string }> = {
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  m4a: { kind: 'audio', mime: 'audio/x-m4a' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/opus' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/x-m4v' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  png: { kind: 'image', mime: 'image/png' },
  webp: { kind: 'image', mime: 'image/webp' },
  vtt: { kind: 'transcript', mime: 'text/vtt' },
  srt: { kind: 'transcript', mime: 'application/x-subrip' },
  html: { kind: 'transcript', mime: 'text/html' },
  htm: { kind: 'transcript', mime: 'text/html' },
  txt: { kind: 'transcript', mime: 'text/plain' },
  json: { kind: 'transcript', mime: 'application/json' }, // or chapters, when asked for
};

const KINDS: MediaKind[] = ['audio', 'video', 'image', 'transcript', 'chapters'];

export interface MediaJson {
  id: string;
  kind: MediaKind;
  url: string;
  mimeType: string | null;
  bytes: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  name: string | null;
  /** For an MP3 just uploaded: how many chapters its ID3 tags hold. */
  id3Chapters?: number;
}

interface MediaRow {
  id: string;
  kind: MediaKind;
  public_path: string;
  mime_type: string | null;
  bytes: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  original_name: string | null;
}

export const mediaJson = (config: Config, m: MediaRow): MediaJson => ({
  id: m.id,
  kind: m.kind,
  url: config.mediaBaseUrl + m.public_path,
  mimeType: m.mime_type,
  bytes: m.bytes === null ? null : Number(m.bytes),
  duration: m.duration,
  width: m.width,
  height: m.height,
  name: m.original_name,
});

/** A finished file of this show, by id. */
export async function getMedia(q: Queryable, config: Config, podcastId: string, mediaId: unknown): Promise<MediaJson | null> {
  if (typeof mediaId !== 'string' || !isUuid(mediaId)) return null;
  const m = await maybeOne<MediaRow>(
    q,
    `SELECT id, kind, public_path, mime_type, bytes, duration, width, height, original_name
       FROM media_files WHERE id = $1 AND podcast_id = $2 AND status = 'done' AND public_path IS NOT NULL`,
    [mediaId, podcastId],
  );
  return m && mediaJson(config, m);
}

interface UploadRow {
  id: string;
  podcast_id: string;
  kind: MediaKind;
  filename: string;
  mime_type: string;
  size: number;
  received: number;
  status: string;
}

const uploadDir = (config: Config) => path.join(path.resolve(config.mediaDir), '.uploads');
const partFile = (config: Config, id: string) => path.join(uploadDir(config), `${id}.part`);

const uploadJson = (u: UploadRow) => ({
  id: u.id,
  kind: u.kind,
  filename: u.filename,
  size: Number(u.size),
  received: Number(u.received),
  chunkSize: CHUNK_SIZE,
});

/** Safe file name: letters, numbers, dot, dash, underscore; keeps the extension. */
export function cleanFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  const ext = m ? `.${m[1]!.toLowerCase()}` : '';
  const stem = base.slice(0, base.length - (m ? m[0].length : 0))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 80);
  return `${stem || 'file'}${ext}`;
}

export async function startUpload(
  db: Db,
  config: Config,
  podcastId: string,
  userId: string,
  input: { filename?: unknown; size?: unknown; type?: unknown; kind?: unknown },
) {
  const original = typeof input.filename === 'string' ? input.filename.trim().slice(0, 255) : '';
  if (!original) throw new UploadError('filename is required');
  const size = typeof input.size === 'number' ? input.size : NaN;
  if (!Number.isSafeInteger(size) || size <= 0) throw new UploadError('size must be the file size in bytes');

  const filename = cleanFilename(original);
  const ext = path.extname(filename).slice(1);
  const known = TYPES[ext];
  const wanted = typeof input.kind === 'string' && input.kind ? input.kind : null;
  if (wanted && !KINDS.includes(wanted as MediaKind)) throw new UploadError(`kind must be one of ${KINDS.join(', ')}`);
  let kind: MediaKind;
  let mime: string;
  if (wanted === 'chapters') {
    if (ext !== 'json') throw new UploadError('Chapters must be a JSON chapters file (.json)');
    kind = 'chapters';
    mime = 'application/json';
  } else {
    if (!known) throw new UploadError(`.${ext || '?'} files aren’t supported here. Use MP3, M4A, MP4, JPEG, PNG, VTT, SRT or JSON.`);
    kind = known.kind;
    mime = known.mime;
    if (wanted && wanted !== kind) throw new UploadError(`A .${ext} file can’t be used as ${wanted === 'image' ? 'an image' : wanted}`);
  }
  const limit = kind === 'audio' || kind === 'video' ? config.maxMediaBytes : kind === 'chapters' ? CHAPTERS_MAX : SMALL_MAX;
  if (size > limit) throw new UploadError(`That file is too large (the limit is ${Math.floor(limit / 1024 / 1024)} MB)`, 413);

  const row = await one<UploadRow>(
    db,
    `INSERT INTO uploads (podcast_id, user_id, kind, filename, mime_type, size)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [podcastId, userId, kind, filename, mime, size],
  );
  await mkdir(uploadDir(config), { recursive: true });
  return uploadJson(row);
}

async function openUpload(q: Queryable, podcastId: string, uploadId: string): Promise<UploadRow> {
  const u = isUuid(uploadId)
    ? await maybeOne<UploadRow>(q, `SELECT * FROM uploads WHERE id = $1 AND podcast_id = $2 AND status = 'open'`, [uploadId, podcastId])
    : null;
  if (!u) throw new UploadError('Upload not found. Start it again.', 404);
  return u;
}

export async function uploadStatus(db: Db, podcastId: string, uploadId: string) {
  return uploadJson(await openUpload(db, podcastId, uploadId));
}

// One chunk at a time per upload (a retried request may race the original).
const locks = new Map<string, Promise<unknown>>();
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

/** Write one chunk at `offset`. The offset must equal what's been received so far. */
export async function appendChunk(
  db: Db,
  config: Config,
  podcastId: string,
  uploadId: string,
  offset: number,
  body: AsyncIterable<Buffer | string>,
) {
  return withLock(uploadId, async () => {
    const u = await openUpload(db, podcastId, uploadId);
    const received = Number(u.received);
    const size = Number(u.size);
    if (!Number.isSafeInteger(offset) || offset !== received) {
      throw new UploadError(`This upload continues at byte ${received}`, 409, { received });
    }
    const file = partFile(config, u.id);
    const exists = await stat(file).then(() => true, () => false);
    if (!exists && received > 0) {
      await db.query(`UPDATE uploads SET received = 0, updated_at = now() WHERE id = $1`, [u.id]);
      throw new UploadError('The partial upload was lost; start from the beginning', 409, { received: 0 });
    }
    const max = Math.min(MAX_CHUNK, size - received);
    const fh = await open(file, exists ? 'r+' : 'w');
    let pos = offset;
    try {
      for await (const c of body) {
        const chunk = typeof c === 'string' ? Buffer.from(c) : c;
        if (pos + chunk.length - offset > max) {
          throw new UploadError(pos + chunk.length > size ? 'More data than the file size given' : `Chunks can be at most ${MAX_CHUNK / 1024 / 1024} MB`, 413);
        }
        await fh.write(chunk, 0, chunk.length, pos);
        pos += chunk.length;
      }
      await fh.truncate(pos);
    } finally {
      await fh.close();
    }
    await db.query(`UPDATE uploads SET received = $2, updated_at = now() WHERE id = $1`, [u.id, pos]);
    return { received: pos, size };
  });
}

/** All bytes are in: check the file, store it, and record it as the show's media. */
export async function completeUpload(db: Db, config: Config, podcastId: string, uploadId: string): Promise<MediaJson> {
  return withLock(uploadId, async () => {
    const u = await openUpload(db, podcastId, uploadId);
    if (Number(u.received) !== Number(u.size)) {
      throw new UploadError(`The upload isn’t finished (${u.received} of ${u.size} bytes)`, 409, { received: Number(u.received) });
    }
    const moving = await maybeOne(db, `SELECT 1 FROM storage_moves WHERE status IN ('queued', 'running')`);
    if (moving) throw new UploadError('Media is being moved to new storage right now. Try again when the move finishes.', 409);

    const file = partFile(config, u.id);
    if (u.kind === 'chapters' || u.mime_type === 'application/json') {
      let json: unknown;
      try {
        json = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        throw new UploadError('That isn’t a valid JSON file');
      }
      if (u.kind === 'chapters' && !Array.isArray((json as { chapters?: unknown })?.chapters)) {
        throw new UploadError('That JSON file has no "chapters" list. Use the Podcast Namespace chapters format.');
      }
    }
    const info = u.kind === 'audio' || u.kind === 'video' || u.kind === 'image' ? await probeFile(file, u.mime_type) : {};
    const id3Chapters = u.kind === 'audio' && u.mime_type === 'audio/mpeg' ? await readId3Chapters(file).then((c) => c.length, () => 0) : undefined;
    if (u.kind === 'image' && !info.width) throw new UploadError('That file isn’t a readable JPEG, PNG or WebP image');

    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    const p = await one<{ slug: string }>(db, `SELECT slug FROM podcasts WHERE id = $1`, [podcastId]);
    const filename = `${u.id.slice(0, 8)}-${u.filename}`;
    const publicPath = mediaPath(p.slug, KIND_DIRS[u.kind] ?? 'other', filename);
    const key = publicPath.slice(1);
    const store = activeStore(config);
    const { storagePath } = await store.putFile(key, file, { size: Number(u.size), contentType: u.mime_type, sha256 });

    const m = await db.tx(async (q) => {
      const row = await one<MediaRow>(
        q,
        `INSERT INTO media_files (podcast_id, kind, original_url, storage_path, public_path, mime_type, bytes, sha256,
                                  status, storage_key, storage_provider, duration, width, height, original_name)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, 'done', $8, $9, $10, $11, $12, $13)
         RETURNING id, kind, public_path, mime_type, bytes, duration, width, height, original_name`,
        [podcastId, u.kind, storagePath, publicPath, u.mime_type, u.size, sha256, key, store.id,
          info.duration ?? null, info.width ?? null, info.height ?? null, u.filename],
      );
      await q.query(`UPDATE uploads SET status = 'done', media_id = $2, updated_at = now() WHERE id = $1`, [u.id, row.id]);
      return row;
    });
    await rm(file, { force: true });
    return { ...mediaJson(config, m), ...(id3Chapters ? { id3Chapters } : {}) };
  });
}

export async function cancelUpload(db: Db, config: Config, podcastId: string, uploadId: string): Promise<void> {
  const u = await openUpload(db, podcastId, uploadId);
  await db.query(`DELETE FROM uploads WHERE id = $1`, [u.id]);
  await rm(partFile(config, u.id), { force: true });
}

/**
 * Housekeeping, run hourly: drop uploads abandoned for a day, their partial
 * files, and uploaded files that were never used in an episode or the show.
 */
export async function cleanupUploads(db: Db, config: Config, log?: (m: string) => void): Promise<void> {
  await db.query(`DELETE FROM uploads WHERE updated_at < now() - interval '1 day'`);
  const { rows: open } = await db.query<{ id: string }>(`SELECT id FROM uploads WHERE status = 'open'`);
  const keep = new Set(open.map((r) => `${r.id}.part`));
  const files = await readdir(uploadDir(config)).catch(() => [] as string[]);
  for (const f of files) if (!keep.has(f)) await rm(path.join(uploadDir(config), f), { force: true });

  const { rows: unused } = await db.query<{ podcast_id: string; public_path: string }>(
    `SELECT podcast_id, public_path FROM media_files
      WHERE original_url IS NULL AND status = 'done' AND public_path IS NOT NULL AND created_at < now() - interval '2 days'`,
  );
  const byShow = new Map<string, string[]>();
  for (const r of unused) byShow.set(r.podcast_id, [...(byShow.get(r.podcast_id) ?? []), r.public_path]);
  for (const [podcastId, paths] of byShow) {
    const n = await pruneMedia(db, config, podcastId, paths, log);
    if (n) log?.(`removed ${n} unused upload${n === 1 ? '' : 's'}`);
  }
}
