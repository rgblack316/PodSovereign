/**
 * Episode chapters, edited in the dashboard.
 *
 * The feed points at a Podcasting 2.0 JSON chapters file
 * (<podcast:chapters type="application/json+chapters">); the editor reads and
 * writes that file, saving a new one on each change (so a CDN never serves a
 * stale copy). Chapters can also be read from, and written into, the MP3's
 * own ID3 tags, which Apple Podcasts and other apps use.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { maybeOne, one, type Db, type Queryable } from '../db/db.js';
import { readId3Chapters, writeId3Chapters, type Id3Chapter } from '../media/id3.js';
import { pruneMedia } from '../media/prune.js';
import { freeMediaName, mediaStem } from '../media/naming.js';
import { getMedia } from '../media/uploads.js';
import { activeStore, localPath, storeFor } from '../storage/store.js';
import { mediaPath } from '../urls.js';
import { PublishError } from './fields.js';
import { updateEpisode } from './episodes.js';

export interface Chapter {
  startTime: number;
  title: string;
  url: string | null;
  img: string | null;
  /** Shown in the chapter list (false = a hidden marker, such as an ad break). */
  toc: boolean;
}

const MAX_CHAPTERS = 500;

interface MediaRow {
  id: string;
  kind: string;
  public_path: string;
  storage_key: string | null;
  storage_path: string | null;
  storage_provider: string | null;
  mime_type: string | null;
  bytes: string | number | null;
  duration: number | null;
  original_name: string | null;
}

/** One of this show's stored files, by its public address. */
async function mediaByUrl(q: Queryable, config: Config, podcastId: string, url: string | null): Promise<MediaRow | null> {
  if (!url || !url.startsWith(config.mediaBaseUrl + '/')) return null;
  return maybeOne<MediaRow>(
    q,
    `SELECT id, kind, public_path, storage_key, storage_path, storage_provider, mime_type, bytes, duration, original_name
       FROM media_files WHERE podcast_id = $1 AND public_path = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
    [podcastId, url.slice(config.mediaBaseUrl.length)],
  );
}

async function mediaById(q: Queryable, podcastId: string, id: string): Promise<MediaRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return maybeOne<MediaRow>(
    q,
    `SELECT id, kind, public_path, storage_key, storage_path, storage_provider, mime_type, bytes, duration, original_name
       FROM media_files WHERE podcast_id = $1 AND id = $2 AND status = 'done'`,
    [podcastId, id],
  );
}

const keyOf = (m: MediaRow) => m.storage_key ?? m.public_path.slice(1);

async function readStored(config: Config, m: MediaRow): Promise<Buffer> {
  return storeFor(config, m.storage_provider).getBuffer(keyOf(m));
}

const isMp3 = (m: MediaRow) => m.mime_type === 'audio/mpeg' || /\.mp3$/i.test(m.public_path);

// ───────────── the JSON file ─────────────

function httpUrl(v: unknown, what: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new PublishError(`${what} must be a web address`);
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    return u.toString();
  } catch {
    throw new PublishError(`${what} must be a full web address starting with https://`);
  }
}

const fmt = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

/** Check chapters from the editor; images may be uploaded files ({mediaId}) or addresses. */
export async function validateChapters(q: Queryable, config: Config, podcastId: string, input: unknown): Promise<Chapter[]> {
  if (!Array.isArray(input)) throw new PublishError('Chapters must be a list');
  if (input.length > MAX_CHAPTERS) throw new PublishError(`At most ${MAX_CHAPTERS} chapters`);
  const out: Chapter[] = [];
  for (const [i, raw] of input.entries()) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const n = `Chapter ${i + 1}`;
    const startTime = typeof c.startTime === 'string' ? Number(c.startTime) : c.startTime;
    if (typeof startTime !== 'number' || !Number.isFinite(startTime) || startTime < 0) throw new PublishError(`${n}: the start time must be 0 or more seconds`);
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    if (!title) throw new PublishError(`${n} needs a title`);
    if (title.length > 500) throw new PublishError(`${n}: the title is too long`);
    let img: string | null = null;
    if (c.img && typeof c.img === 'object') {
      const m = await getMedia(q, config, podcastId, (c.img as { mediaId?: unknown }).mediaId);
      if (!m || m.kind !== 'image') throw new PublishError(`${n}: that image wasn’t found. Upload it again.`);
      img = m.url;
    } else img = httpUrl(c.img, `${n} image`);
    out.push({ startTime: Math.round(startTime * 1000) / 1000, title, url: httpUrl(c.url, `${n} link`), img, toc: c.toc !== false });
  }
  out.sort((a, b) => a.startTime - b.startTime);
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.startTime === out[i - 1]!.startTime) throw new PublishError(`Two chapters start at ${fmt(out[i]!.startTime)}`);
  }
  return out;
}

/** The Podcasting 2.0 JSON chapters document. */
export function chaptersJson(chapters: Chapter[]): string {
  return JSON.stringify({
    version: '1.2.0',
    chapters: chapters.map((c) => ({
      startTime: c.startTime,
      title: c.title,
      ...(c.img ? { img: c.img } : {}),
      ...(c.url ? { url: c.url } : {}),
      ...(c.toc ? {} : { toc: false }),
    })),
  }, null, 2);
}

/** Read a JSON chapters document (from a file or the editor's import). */
export function parseChaptersJson(text: string): Chapter[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PublishError('That isn’t a valid JSON file');
  }
  const list = (doc as { chapters?: unknown })?.chapters;
  if (!Array.isArray(list)) throw new PublishError('That JSON file has no "chapters" list. Use the Podcast Namespace chapters format.');
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as { startTime?: unknown }).startTime === 'number')
    .map((c) => ({
      startTime: c.startTime as number,
      title: typeof c.title === 'string' ? c.title : '',
      url: typeof c.url === 'string' ? c.url : null,
      img: typeof c.img === 'string' ? c.img : null,
      toc: c.toc !== false,
    }))
    .sort((a, b) => a.startTime - b.startTime);
}

interface EpisodeRow {
  id: string;
  enclosure_url: string | null;
  enclosure_media_id: string | null;
  itunes_duration: number | null;
  id3_status: string | null;
  id3_error: string | null;
  id3_at: Date | null;
}

async function episodeRow(q: Queryable, podcastId: string, episodeId: string): Promise<EpisodeRow> {
  if (!/^[0-9a-f-]{36}$/i.test(episodeId)) throw new PublishError('Episode not found', 404);
  const e = await maybeOne<EpisodeRow>(
    q,
    `SELECT id, enclosure_url, enclosure_media_id, itunes_duration, id3_status, id3_error, id3_at FROM episodes WHERE id = $1 AND podcast_id = $2`,
    [episodeId, podcastId],
  );
  if (!e) throw new PublishError('Episode not found', 404);
  return e;
}

async function chaptersUrl(q: Queryable, episodeId: string): Promise<string | null> {
  const t = await maybeOne<{ url: string }>(
    q,
    `SELECT attributes->>'url' AS url FROM tag_elements WHERE episode_id = $1 AND ns_prefix = 'podcast' AND name = 'chapters' LIMIT 1`,
    [episodeId],
  );
  return t?.url ?? null;
}

async function enclosureMedia(q: Queryable, config: Config, podcastId: string, e: EpisodeRow): Promise<MediaRow | null> {
  return (e.enclosure_media_id ? await mediaById(q, podcastId, e.enclosure_media_id) : null) ?? (await mediaByUrl(q, config, podcastId, e.enclosure_url));
}

/** What the editor opens with. */
export async function getChapters(db: Db, config: Config, podcastId: string, episodeId: string) {
  const e = await episodeRow(db, podcastId, episodeId);
  const url = await chaptersUrl(db, episodeId);
  let chapters: Chapter[] = [];
  let error: string | null = null;
  if (url) {
    const m = await mediaByUrl(db, config, podcastId, url);
    try {
      if (!m) throw new PublishError('The chapters file isn’t stored on this site, so it can’t be edited here. Upload it to replace it.');
      chapters = parseChaptersJson((await readStored(config, m)).toString('utf8'));
    } catch (err) {
      error = (err as Error).message;
    }
  }
  const audio = await enclosureMedia(db, config, podcastId, e);
  return {
    url,
    chapters,
    error,
    audio: audio ? { mediaId: audio.id, mp3: isMp3(audio), url: config.mediaBaseUrl + audio.public_path } : null,
    duration: e.itunes_duration ?? audio?.duration ?? null,
    mp3Write: { status: e.id3_status, error: e.id3_error, at: e.id3_at },
  };
}

/**
 * Save the editor's chapters as a new JSON file and point the episode at it
 * (an empty list removes chapters). Returns files the episode stopped using.
 */
export async function saveChapters(db: Db, config: Config, podcastId: string, episodeId: string, input: unknown): Promise<string[]> {
  await episodeRow(db, podcastId, episodeId);
  const chapters = await validateChapters(db, config, podcastId, input);
  if (!chapters.length) {
    const { dropped } = await db.tx((q) => updateEpisode(q, config, podcastId, episodeId, { chapters: null }));
    return dropped;
  }
  const p = await one<{ slug: string }>(db, `SELECT slug FROM podcasts WHERE id = $1`, [podcastId]);
  const body = Buffer.from(chaptersJson(chapters));
  const publicPath = mediaPath(p.slug, 'chapters', `${randomBytes(4).toString('hex')}-chapters.json`);
  const key = publicPath.slice(1);
  const store = activeStore(config);
  await store.putBuffer(key, body, 'application/json');
  return db.tx(async (q) => {
    const m = await one<{ id: string }>(
      q,
      `INSERT INTO media_files (podcast_id, kind, storage_path, public_path, mime_type, bytes, sha256, status, storage_key, storage_provider, original_name)
       VALUES ($1, 'chapters', $2, $3, 'application/json', $4, $5, 'done', $6, $7, 'chapters.json') RETURNING id`,
      [podcastId, store.isLocal ? localPath(config.mediaDir, key) : null, publicPath, body.length, createHash('sha256').update(body).digest('hex'), key, store.id],
    );
    const { dropped } = await updateEpisode(q, config, podcastId, episodeId, { chapters: { mediaId: m.id } });
    return dropped;
  });
}

// ───────────── chapters inside the MP3 ─────────────

const staging = (config: Config) => path.join(path.resolve(config.mediaDir), '.staging');

/** The MP3 on disk: its own path when stored here, else a temporary copy (and a cleanup). */
async function localCopy(config: Config, m: MediaRow): Promise<{ file: string; done: () => Promise<void> }> {
  if ((!m.storage_provider || m.storage_provider === 'local') && m.storage_path && (await stat(m.storage_path).catch(() => null))) {
    return { file: m.storage_path, done: async () => {} };
  }
  await mkdir(staging(config), { recursive: true });
  const file = path.join(staging(config), `${randomBytes(8).toString('hex')}.mp3`);
  await storeFor(config, m.storage_provider).getToFile(keyOf(m), file);
  return { file, done: () => rm(file, { force: true }) };
}

/** Save an image from the MP3's tags as one of the show's files; returns its address. */
async function saveImage(db: Db, config: Config, podcastId: string, slug: string, img: { mime: string; data: Buffer }): Promise<string> {
  const ext = img.mime === 'image/png' ? 'png' : img.mime === 'image/webp' ? 'webp' : 'jpg';
  const sha = createHash('sha256').update(img.data).digest('hex');
  // The same picture on several chapters is saved once.
  const existing = await maybeOne<MediaRow>(
    db, `SELECT id, kind, public_path, storage_key, storage_path, storage_provider, mime_type, bytes, duration, original_name FROM media_files WHERE podcast_id = $1 AND sha256 = $2 AND kind = 'image' AND status = 'done' LIMIT 1`, [podcastId, sha],
  );
  if (existing) return config.mediaBaseUrl + existing.public_path;
  const publicPath = mediaPath(slug, 'images', `${sha.slice(0, 10)}-chapter.${ext}`);
  const key = publicPath.slice(1);
  const store = activeStore(config);
  await store.putBuffer(key, img.data, img.mime);
  await db.query(
    `INSERT INTO media_files (podcast_id, kind, storage_path, public_path, mime_type, bytes, sha256, status, storage_key, storage_provider, original_name)
     VALUES ($1, 'image', $2, $3, $4, $5, $6, 'done', $7, $8, $9)`,
    [podcastId, store.isLocal ? localPath(config.mediaDir, key) : null, publicPath, img.mime, img.data.length, sha, key, store.id, `chapter.${ext}`],
  );
  return config.mediaBaseUrl + publicPath;
}

/** Chapters found in an MP3's tags (one of this show's files), with their images saved as files. */
export async function chaptersFromAudio(db: Db, config: Config, podcastId: string, mediaId: string): Promise<Chapter[]> {
  const m = await mediaById(db, podcastId, mediaId);
  if (!m || m.kind !== 'audio') throw new PublishError('That audio file wasn’t found', 404);
  if (!isMp3(m)) throw new PublishError('Chapters can only be read from MP3 files');
  const copy = await localCopy(config, m);
  let found: Id3Chapter[];
  try {
    found = await readId3Chapters(copy.file);
  } finally {
    await copy.done();
  }
  const { slug } = await one<{ slug: string }>(db, `SELECT slug FROM podcasts WHERE id = $1`, [podcastId]);
  const out: Chapter[] = [];
  for (const c of found) {
    out.push({ startTime: c.startTime, title: c.title, url: c.url, img: c.image ? await saveImage(db, config, podcastId, slug, c.image) : null, toc: c.toc });
  }
  return out;
}

/** How many chapters an MP3 has, from a file on disk (used right after an upload). */
export async function countId3Chapters(file: string): Promise<number> {
  try {
    return (await readId3Chapters(file)).length;
  } catch {
    return 0;
  }
}

const writing = new Map<string, { again: boolean }>();

/**
 * Write the episode's chapters into its MP3 (in the background). The new file
 * gets a new address so podcast apps and CDNs fetch it fresh; the old one is
 * removed. If the chapters change again meanwhile, it runs once more after.
 */
export function startMp3ChapterWrite(db: Db, config: Config, podcastId: string, episodeId: string, log?: (m: string) => void): void {
  const running = writing.get(episodeId);
  if (running) {
    running.again = true;
    return;
  }
  const state = { again: false };
  writing.set(episodeId, state);
  void (async () => {
    try {
      do {
        state.again = false;
        await writeMp3Chapters(db, config, podcastId, episodeId, log);
      } while (state.again);
    } finally {
      writing.delete(episodeId);
    }
  })();
}

export const isWritingMp3 = (episodeId: string) => writing.has(episodeId);

export async function writeMp3Chapters(db: Db, config: Config, podcastId: string, episodeId: string, log?: (m: string) => void): Promise<void> {
  await db.query(`UPDATE episodes SET id3_status = 'running', id3_error = NULL, id3_at = now() WHERE id = $1`, [episodeId]);
  let src: { file: string; done: () => Promise<void> } | null = null;
  const out = path.join(staging(config), `${randomBytes(8).toString('hex')}.mp3`);
  try {
    const e = await episodeRow(db, podcastId, episodeId);
    const audio = await enclosureMedia(db, config, podcastId, e);
    if (!audio) throw new PublishError('The audio isn’t stored on this site, so its chapters can’t be written');
    if (!isMp3(audio)) throw new PublishError('Chapters can only be written into MP3 files');
    const { chapters } = await getChapters(db, config, podcastId, episodeId);
    const withImages: Id3Chapter[] = [];
    for (const c of chapters) {
      let image: Id3Chapter['image'] = null;
      const im = await mediaByUrl(db, config, podcastId, c.img);
      if (im && /^image\/(jpeg|png|webp)$/.test(im.mime_type ?? '')) image = { mime: im.mime_type!, data: await readStored(config, im) };
      withImages.push({ startTime: c.startTime, endTime: null, title: c.title, url: c.url, image, toc: c.toc });
    }
    src = await localCopy(config, audio);
    await mkdir(staging(config), { recursive: true });
    await writeId3Chapters(src.file, out, withImages, e.itunes_duration ?? audio.duration);
    const size = (await stat(out)).size;
    const sha256 = await new Promise<string>((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(out).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    const { slug } = await one<{ slug: string }>(db, `SELECT slug FROM podcasts WHERE id = $1`, [podcastId]);
    const publicPath = mediaPath(slug, 'audio', await freeMediaName(db, slug, 'audio', mediaStem(audio) || 'episode', 'mp3'));
    const key = publicPath.slice(1);
    const store = activeStore(config);
    const { storagePath } = await store.putFile(key, out, { size, contentType: 'audio/mpeg', sha256 });
    const dropped = await db.tx(async (q) => {
      const m = await one<{ id: string }>(
        q,
        `INSERT INTO media_files (podcast_id, kind, storage_path, public_path, mime_type, bytes, sha256, status, storage_key, storage_provider, duration, original_name)
         VALUES ($1, 'audio', $2, $3, 'audio/mpeg', $4, $5, 'done', $6, $7, $8, $9) RETURNING id`,
        [podcastId, storagePath, publicPath, size, sha256, key, store.id, audio.duration, audio.original_name],
      );
      const r = await updateEpisode(q, config, podcastId, episodeId, { enclosure: { mediaId: m.id } });
      await q.query(`UPDATE episodes SET id3_status = 'done', id3_error = NULL, id3_at = now() WHERE id = $1`, [episodeId]);
      return r.dropped;
    });
    await pruneMedia(db, config, podcastId, dropped, log);
    log?.(`chapters written into the MP3 for episode ${episodeId} (${withImages.length})`);
  } catch (err) {
    await db.query(`UPDATE episodes SET id3_status = 'failed', id3_error = $2, id3_at = now() WHERE id = $1`, [episodeId, (err as Error).message]).catch(() => {});
    log?.(`writing chapters into the MP3 for episode ${episodeId} failed: ${(err as Error).message}`);
  } finally {
    await src?.done();
    await rm(out, { force: true });
  }
}

