import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { maybeOne, one, type Db } from '../db/db.js';
import {
  createPodcast,
  loadFeed,
  setPrefixConfig,
  slugify,
  uniqueSlug,
  writeFeedContent,
} from '../db/podcasts.js';
import { chapterImageUrls, collectMediaRefs, rewriteChapterImages, type MediaKind } from '../feed/media.js';
import { parseFeed } from '../feed/parser.js';
import type { Feed } from '../feed/types.js';
import { mediaPath, mediaPrefix, RESERVED_SLUGS } from '../urls.js';
import { downloadToFile, FetchError, fetchFeedText, withRetry } from './http.js';

export interface ImportJob {
  id: string;
  podcast_id: string | null;
  user_id: string;
  source_url: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  options: { slug?: string };
  attempts: number;
}

export interface ImportProgress {
  stage: 'fetching' | 'saving' | 'media' | 'finishing' | 'done';
  episodes?: number;
  mediaTotal?: number;
  mediaDone?: number;
  mediaFailed?: number;
  mediaBytes?: number;
}

export interface ImporterDeps {
  db: Db;
  config: Config;
  log?: (msg: string) => void;
}

export class ImportError extends Error {}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const MAX_ATTEMPTS = 3;

// ───────────── Queue ─────────────

export async function enqueueImport(db: Db, userId: string, sourceUrl: string, options: { slug?: string } = {}) {
  let u: URL;
  try {
    u = new URL(sourceUrl.trim());
  } catch {
    throw new ImportError('Enter the full feed URL, starting with https://');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ImportError('Feed URL must start with http:// or https://');
  if (options.slug !== undefined && !SLUG_RE.test(options.slug)) {
    throw new ImportError('Feed address may only use lowercase letters, numbers and dashes');
  }
  if (options.slug !== undefined && RESERVED_SLUGS.has(options.slug)) {
    throw new ImportError(`"${options.slug}" is reserved; choose a different feed address`);
  }
  return one<{ id: string }>(
    db,
    `INSERT INTO import_jobs (user_id, source_url, options, progress) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, u.toString(), JSON.stringify(options), JSON.stringify({ stage: 'fetching' })],
  );
}

/** Atomically take the oldest queued job (safe with several workers). */
export async function claimNextJob(db: Db): Promise<ImportJob | null> {
  return maybeOne<ImportJob>(
    db,
    `UPDATE import_jobs SET status = 'running', attempts = attempts + 1,
            started_at = COALESCE(started_at, now()), heartbeat_at = now()
      WHERE id = (SELECT id FROM import_jobs WHERE status = 'queued'
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, podcast_id, user_id, source_url, status, options, attempts`,
  );
}

/** Requeue jobs whose worker died (no heartbeat for 5 minutes). */
export async function requeueStaleJobs(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE import_jobs SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
            error = CASE WHEN attempts >= $1 THEN 'Import stopped responding too many times' ELSE error END
      WHERE status = 'running' AND heartbeat_at < now() - interval '5 minutes'`,
    [MAX_ATTEMPTS],
  );
  return r.rowCount;
}

async function setProgress(db: Db, jobId: string, progress: ImportProgress) {
  await db.query(`UPDATE import_jobs SET progress = $2, heartbeat_at = now() WHERE id = $1`, [jobId, JSON.stringify(progress)]);
}

// ───────────── Running a job ─────────────

export async function runImportJob(deps: ImporterDeps, job: ImportJob): Promise<void> {
  const { db } = deps;
  const warnings: string[] = [];
  try {
    const { feed, podcastId, slug } = job.podcast_id
      ? await resume(deps, job)
      : await fetchAndSave(deps, job, warnings);
    await copyMedia(deps, job.id, podcastId, slug, feed, warnings);
    await db.query(
      `UPDATE import_jobs SET status = 'done', finished_at = now(), heartbeat_at = now(),
              warnings = warnings || $2::jsonb WHERE id = $1`,
      [job.id, JSON.stringify(warnings)],
    );
    deps.log?.(`import ${job.id} done (${warnings.length} warnings)`);
  } catch (e) {
    const msg = e instanceof ImportError || e instanceof FetchError ? e.message : `Unexpected error: ${(e as Error).message}`;
    await db.query(
      `UPDATE import_jobs SET status = 'failed', error = $2, finished_at = now(),
              warnings = warnings || $3::jsonb WHERE id = $1`,
      [job.id, msg, JSON.stringify(warnings)],
    );
    deps.log?.(`import ${job.id} failed: ${msg}`);
  }
}

async function fetchAndSave(deps: ImporterDeps, job: ImportJob, warnings: string[]) {
  const { db, config } = deps;
  await setProgress(db, job.id, { stage: 'fetching' });
  const { text, finalUrl } = await withRetry(() =>
    fetchFeedText(job.source_url, { allowPrivate: config.allowPrivateNetworks, maxBytes: config.maxFeedBytes }),
  );
  if (finalUrl !== job.source_url) warnings.push(`Feed redirected to ${finalUrl}`);

  let parsed;
  try {
    parsed = parseFeed(text);
  } catch (e) {
    throw new ImportError(`That URL isn't a podcast RSS feed (${(e as Error).message})`);
  }
  const { feed, detectedPrefixes, removedPrefixes } = parsed;
  warnings.push(...parsed.warnings.filter((w) => !w.includes('podcast:locked')));

  // Podcasting 2.0: a locked feed must not be imported until its owner unlocks it at the current host.
  if (feed.channel.podcastLocked) {
    throw new ImportError(
      'This feed is locked (<podcast:locked>yes</podcast:locked>). Unlock it in your current host\'s settings, then import again.',
    );
  }

  dedupeEpisodes(feed, warnings);

  if (!feed.channel.podcastGuid) {
    feed.channel.podcastGuid = podcastGuidFor(finalUrl);
    warnings.push(`Feed had no <podcast:guid>; generated ${feed.channel.podcastGuid} from its URL (per the Podcast Index spec)`);
  }
  if (feed.channel.itunesNewFeedUrl) {
    warnings.push(`Removed <itunes:new-feed-url> (${feed.channel.itunesNewFeedUrl}) so apps aren't sent elsewhere`);
    feed.channel.itunesNewFeedUrl = null;
  }
  if (removedPrefixes.length) warnings.push(`Removed defunct stats prefix ${removedPrefixes.join(', ')}`);

  const existing = await maybeOne<{ owner_id: string }>(db, `SELECT owner_id FROM podcasts WHERE podcast_guid = $1 LIMIT 1`, [
    feed.channel.podcastGuid,
  ]);
  if (existing) {
    throw new ImportError(
      existing.owner_id === job.user_id
        ? 'You have already imported this podcast.'
        : 'This podcast is already hosted on this server by another account.',
    );
  }

  await setProgress(db, job.id, { stage: 'saving', episodes: feed.items.length });
  const { podcastId, slug } = await db.tx(async (q) => {
    const slug = job.options.slug ? await assertSlugFree(q, job.options.slug) : await uniqueSlug(q, slugify(feed.channel.title));
    const podcastId = await createPodcast(q, {
      ownerId: job.user_id,
      slug,
      sourceUrl: finalUrl,
      title: feed.channel.title,
      status: 'importing',
    });
    await writeFeedContent(q, podcastId, feed);
    try {
      await setPrefixConfig(q, podcastId, { settings: detectedPrefixes, prefixAlternateEnclosures: false });
      if (detectedPrefixes.length) {
        warnings.push(`Kept your stats prefixes: ${detectedPrefixes.map((p) => p.serviceKey).join(', ')} (change them in Settings)`);
      }
    } catch (e) {
      warnings.push(`Couldn't keep existing stats prefixes: ${(e as Error).message}`);
    }
    await q.query(`UPDATE import_jobs SET podcast_id = $2 WHERE id = $1`, [job.id, podcastId]);
    return { podcastId, slug };
  });
  return { feed, podcastId, slug };
}

async function resume(deps: ImporterDeps, job: ImportJob) {
  const podcastId = job.podcast_id!;
  const row = await maybeOne<{ slug: string }>(deps.db, `SELECT slug FROM podcasts WHERE id = $1`, [podcastId]);
  const feed = row && (await loadFeed(deps.db, podcastId));
  if (!row || !feed) throw new ImportError('The podcast for this import no longer exists');
  return { feed, podcastId, slug: row.slug };
}

async function assertSlugFree(q: Parameters<typeof uniqueSlug>[0], slug: string) {
  const taken = await maybeOne(q, `SELECT 1 FROM podcasts WHERE slug = $1`, [slug]);
  if (taken) throw new ImportError(`The feed address "${slug}" is already taken`);
  return slug;
}

function dedupeEpisodes(feed: Feed, warnings: string[]) {
  const seen = new Set<string>();
  const before = feed.items.length;
  feed.items = feed.items.filter((it) => (seen.has(it.guid) ? false : (seen.add(it.guid), true)));
  if (feed.items.length < before) warnings.push(`Skipped ${before - feed.items.length} duplicate episode(s) with repeated <guid>`);
}

// ───────────── Media ─────────────

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
  'audio/opus': '.opus', 'audio/wav': '.wav', 'audio/flac': '.flac', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'text/vtt': '.vtt', 'application/x-subrip': '.srt', 'application/srt': '.srt', 'text/html': '.html',
  'application/json': '.json', 'application/json+chapters': '.json', 'text/plain': '.txt',
};

/** Stable, collision-free, filesystem-safe name: <hash>-<original basename>. */
export function mediaFilename(url: string, mimeType?: string | null): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 10);
  let base = 'file';
  try {
    base = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file');
  } catch {
    /* keep default */
  }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-80) || 'file';
  if (!path.extname(base) && mimeType && EXT_BY_MIME[mimeType]) base += EXT_BY_MIME[mimeType];
  return `${hash}-${base}`;
}

/** Sub-folder for each kind of file inside a podcast's media folder. */
export const KIND_DIRS: Record<MediaKind, string> = {
  audio: 'audio',
  video: 'video',
  image: 'images',
  transcript: 'transcripts',
  chapters: 'chapters',
  other: 'other',
};

interface MediaRow {
  id: string;
  kind: MediaKind;
  original_url: string;
  status: string;
  storage_path: string | null;
  public_path: string | null;
  bytes: number | null;
}

interface Copied {
  publicUrl: string;
  storagePath: string;
  bytes: number;
}

/**
 * Copies every referenced file into MEDIA_DIR/<slug>/<kind>/, then:
 *  - copies the images listed inside JSON chapter files and rewrites those files,
 *  - points every reference in the feed (tags, show-notes <img>, srcsets) at the copies.
 * Already-finished files (from an interrupted run) are not downloaded again.
 */
async function copyMedia(
  deps: ImporterDeps,
  jobId: string,
  podcastId: string,
  slug: string,
  feed: Feed,
  warnings: string[],
) {
  const { db, config } = deps;
  const publicPrefix = config.mediaBaseUrl + mediaPrefix(slug);
  const refs = collectMediaRefs(feed).filter((r) => !r.url.startsWith(publicPrefix));
  const result = new Map<string, Copied>();
  const progress: ImportProgress = {
    stage: 'media',
    episodes: feed.items.length,
    mediaTotal: 0,
    mediaDone: 0,
    mediaFailed: 0,
    mediaBytes: 0,
  };

  /** Register URLs, then download whichever aren't done yet. */
  const copyAll = async (wanted: Map<string, MediaKind>) => {
    if (!wanted.size) return;
    await db.query(
      `INSERT INTO media_files (podcast_id, kind, original_url)
       SELECT $1, x.kind, x.url FROM jsonb_to_recordset($2::jsonb) AS x(kind text, url text)
       ON CONFLICT (podcast_id, original_url) DO NOTHING`,
      [podcastId, JSON.stringify([...wanted].map(([url, kind]) => ({ url, kind })))],
    );
    const { rows } = await db.query<MediaRow>(
      `SELECT id, kind, original_url, status, storage_path, public_path, bytes FROM media_files
        WHERE podcast_id = $1 AND original_url IN (SELECT jsonb_array_elements_text($2::jsonb))`,
      [podcastId, JSON.stringify([...wanted.keys()])],
    );
    progress.mediaTotal! += rows.length;
    const todo = rows.filter((m) => {
      if (m.status === 'done' && m.public_path && m.storage_path) {
        result.set(m.original_url, { publicUrl: config.mediaBaseUrl + m.public_path, storagePath: m.storage_path, bytes: m.bytes ?? 0 });
        progress.mediaDone!++;
        return false;
      }
      return true;
    });
    await setProgress(db, jobId, progress);

    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const m = todo[next++]!;
        const dir = KIND_DIRS[m.kind] ?? 'other';
        const filename = mediaFilename(m.original_url);
        const storagePath = path.join(config.mediaDir, slug, dir, filename);
        const publicPath = mediaPath(slug, dir, filename);
        try {
          const d = await withRetry(() =>
            downloadToFile(m.original_url, storagePath, {
              allowPrivate: config.allowPrivateNetworks,
              maxBytes: config.maxMediaBytes,
              timeoutMs: 60_000,
            }),
          );
          await db.query(
            `UPDATE media_files SET status = 'done', error = NULL, storage_path = $2, public_path = $3,
                    mime_type = $4, bytes = $5, sha256 = $6 WHERE id = $1`,
            [m.id, storagePath, publicPath, d.mimeType, d.bytes, d.sha256],
          );
          result.set(m.original_url, { publicUrl: config.mediaBaseUrl + publicPath, storagePath, bytes: d.bytes });
          progress.mediaDone!++;
          progress.mediaBytes! += d.bytes;
        } catch (e) {
          const msg = (e as Error).message;
          await db.query(`UPDATE media_files SET status = 'failed', error = $2 WHERE id = $1`, [m.id, msg]);
          warnings.push(`Couldn't copy ${m.original_url}: ${msg} (left pointing at the original)`);
          progress.mediaFailed!++;
        }
        await setProgress(db, jobId, progress);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, config.downloadConcurrency) }, worker));
  };

  // 1. Everything the feed references directly.
  const wanted = new Map<string, MediaKind>();
  for (const r of refs) if (!wanted.has(r.url)) wanted.set(r.url, r.kind);
  await copyAll(wanted);

  // 2. Images listed inside the JSON chapter files we just copied.
  const chapterFiles = [...new Set(refs.filter((r) => r.kind === 'chapters').map((r) => r.url))]
    .map((url) => ({ url, copy: result.get(url) }))
    .filter((c): c is { url: string; copy: Copied } => !!c.copy);
  const parsedChapters = new Map<string, unknown>();
  const chapterImages = new Map<string, MediaKind>();
  for (const { url, copy } of chapterFiles) {
    try {
      const json = JSON.parse(await readFile(copy.storagePath, 'utf8'));
      parsedChapters.set(url, json);
      for (const img of chapterImageUrls(json)) if (!img.startsWith(publicPrefix)) chapterImages.set(img, 'image');
    } catch {
      warnings.push(`Chapters file ${url} isn't valid JSON chapters; copied as-is`);
    }
  }
  await copyAll(chapterImages);
  for (const [url, json] of parsedChapters) {
    const swapped = rewriteChapterImages(json, (img) => result.get(img)?.publicUrl);
    if (JSON.stringify(swapped) === JSON.stringify(json)) continue;
    const copy = result.get(url)!;
    const body = Buffer.from(JSON.stringify(swapped, null, 2));
    await writeFile(copy.storagePath, body);
    copy.bytes = body.length;
    await db.query(`UPDATE media_files SET bytes = $2, sha256 = $3 WHERE podcast_id = $1 AND original_url = $4`, [
      podcastId,
      body.length,
      createHash('sha256').update(body).digest('hex'),
      url,
    ]);
  }

  // 3. Fill in missing enclosure lengths, then point every reference at our copies.
  for (const it of feed.items) {
    const got = it.enclosureUrl ? result.get(it.enclosureUrl) : undefined;
    if (got && !it.enclosureLength) it.enclosureLength = got.bytes;
  }
  for (const r of refs) {
    const got = result.get(r.url);
    if (got) r.set(got.publicUrl);
  }

  await setProgress(db, jobId, { ...progress, stage: 'finishing' });
  await db.tx(async (q) => {
    await writeFeedContent(q, podcastId, feed);
    await q.query(`UPDATE podcasts SET status = 'active' WHERE id = $1`, [podcastId]);
    // Imported episodes aren't "new" — only episodes added or scheduled later get announced.
    await q.query(`UPDATE episodes SET announced_at = now() WHERE podcast_id = $1 AND announced_at IS NULL`, [podcastId]);
    await q.query(
      `UPDATE episodes e SET enclosure_media_id = m.id
         FROM media_files m
        WHERE e.podcast_id = $1 AND m.podcast_id = $1 AND m.status = 'done'
          AND e.enclosure_url = $2 || m.public_path`,
      [podcastId, config.mediaBaseUrl],
    );
  });
  // No Podping here on purpose: the show's Podping switch starts off so nothing is
  // announced until the podcaster has finished moving and set up the 301 redirect.
  await setProgress(db, jobId, { ...progress, stage: 'done' });
}

// ───────────── podcast:guid ─────────────

const PODCAST_NAMESPACE_UUID = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6';

/** UUIDv5 of the feed URL with scheme and trailing slashes removed, as the Podcast namespace specifies. */
export function podcastGuidFor(feedUrl: string): string {
  const name = feedUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const h = createHash('sha1')
    .update(Buffer.from(PODCAST_NAMESPACE_UUID.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ───────────── Worker loop ─────────────

export function startImportWorker(deps: ImporterDeps, pollMs = 2000): { stop: () => Promise<void> } {
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  const loop = async () => {
    await requeueStaleJobs(deps.db).catch(() => {});
    while (!stopped) {
      try {
        const job = await claimNextJob(deps.db);
        if (job) {
          current = runImportJob(deps, job);
          await current;
          continue;
        }
      } catch (e) {
        deps.log?.(`worker error: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
  void loop();
  return {
    stop: async () => {
      stopped = true;
      await current;
    },
  };
}

