/**
 * Auphonic processing (https://auphonic.com/help/api/): noise reduction and
 * loudness from the podcaster's own Auphonic preset, plus transcripts.
 *
 * PodSovereign keeps the original upload, creates a production with the
 * episode's metadata and chapters (Auphonic fetches the audio from its public
 * address), and when Auphonic is done (its callback, or the worker checking
 * each minute) downloads the processed MP3 and transcripts into the episode.
 * See docs/auphonic.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import { maybeOne, one, type Db, type Queryable } from '../db/db.js';
import { probeFile } from '../media/probe.js';
import { pruneMedia } from '../media/prune.js';
import { getChapters, saveChapters } from '../publish/chapters.js';
import { updateEpisode } from '../publish/episodes.js';
import { activeStore } from '../storage/store.js';
import { mediaPath } from '../urls.js';

export class AuphonicError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const STATUS_DONE = 3;
const STATUS_ERROR = 2;
/** Auphonic statuses that mean the production stopped without finishing (incomplete, not started, outdated). */
const STATUS_STOPPED = new Set([9, 10, 11]);

// ───────────── the API ─────────────

interface Envelope<T> { status_code?: number; error_message?: string; error_code?: unknown; form_errors?: unknown; data?: T }

async function call<T>(config: Config, method: string, apiPath: string, body?: unknown, key = config.auphonicKey): Promise<T> {
  if (!key) throw new AuphonicError('Auphonic isn’t set up: an administrator adds the API key in Site settings.', 409);
  let res: Response;
  try {
    res = await fetch(config.auphonicUrl.replace(/\/+$/, '') + apiPath, {
      method,
      headers: { Authorization: `bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new AuphonicError(`Couldn’t reach Auphonic: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  let env: Envelope<T> | null = null;
  try {
    env = JSON.parse(text) as Envelope<T>;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) throw new AuphonicError('Auphonic didn’t accept the API key. Check it in Site settings → Auphonic.', 502);
  if (!res.ok || !env || (env.status_code && env.status_code >= 400)) {
    const detail = env?.error_message || (env?.form_errors ? JSON.stringify(env.form_errors) : '') || text.slice(0, 200);
    throw new AuphonicError(`Auphonic answered ${res.status}${detail ? `: ${detail}` : ''}`, 502);
  }
  return env.data as T;
}

/** Check a key; returns the account's username. */
export async function testAuphonicKey(config: Config, key: string): Promise<string> {
  const u = await call<{ username?: string; email?: string }>(config, 'GET', '/api/user.json', undefined, key);
  return u?.username ?? u?.email ?? 'your account';
}

export async function listPresets(config: Config): Promise<{ uuid: string; name: string }[]> {
  const list = await call<{ uuid: string; preset_name?: string }[]>(config, 'GET', '/api/presets.json?minimal_data=1');
  return (list ?? []).map((p) => ({ uuid: p.uuid, name: p.preset_name ?? p.uuid })).sort((a, b) => a.name.localeCompare(b.name));
}

// ───────────── show settings ─────────────

export async function showSettings(q: Queryable, podcastId: string) {
  const r = (await maybeOne<{ auphonic_enabled: boolean; auphonic_preset: string | null; auphonic_preset_name: string | null; auphonic_transcripts: boolean; auphonic_chapters: ChapterSource; auphonic_shownotes: boolean }>(
    q, `SELECT auphonic_enabled, auphonic_preset, auphonic_preset_name, auphonic_transcripts, auphonic_chapters, auphonic_shownotes FROM podcasts WHERE id = $1`, [podcastId],
  ))!;
  return {
    enabled: r.auphonic_enabled, preset: r.auphonic_preset, presetName: r.auphonic_preset_name, transcripts: r.auphonic_transcripts,
    chapters: r.auphonic_chapters, shownotes: r.auphonic_shownotes,
  };
}

export type ChapterSource = 'ours' | 'auphonic';
export interface AiOptions { chapters: ChapterSource; shownotes: boolean }

const chapterSource = (v: unknown, fallback: ChapterSource): ChapterSource => {
  if (v === undefined || v === null) return fallback;
  if (v !== 'ours' && v !== 'auphonic') throw new AuphonicError('Chapters come from "ours" or "auphonic"');
  return v;
};

/** The per-episode choice, defaulting to the show's settings. */
export async function aiOptions(q: Queryable, podcastId: string, input: { chapters?: unknown; shownotes?: unknown } = {}): Promise<AiOptions> {
  const s = await showSettings(q, podcastId);
  return {
    chapters: chapterSource(input.chapters, s.chapters),
    shownotes: input.shownotes === undefined || input.shownotes === null ? s.shownotes : input.shownotes === true,
  };
}

export async function saveShowSettings(db: Db, config: Config, podcastId: string, input: { enabled?: unknown; preset?: unknown; transcripts?: unknown; chapters?: unknown; shownotes?: unknown }) {
  const cur = await showSettings(db, podcastId);
  const enabled = input.enabled === undefined ? cur.enabled : input.enabled === true;
  const transcripts = input.transcripts === undefined ? cur.transcripts : input.transcripts === true;
  const chapters = chapterSource(input.chapters, cur.chapters);
  const shownotes = input.shownotes === undefined ? cur.shownotes : input.shownotes === true;
  let preset = cur.preset;
  let presetName = cur.presetName;
  if (input.preset !== undefined) {
    if (input.preset === null || input.preset === '') {
      preset = presetName = null;
    } else {
      const found = (await listPresets(config)).find((p) => p.uuid === input.preset);
      if (!found) throw new AuphonicError('That preset wasn’t found in your Auphonic account');
      preset = found.uuid;
      presetName = found.name;
    }
  }
  if (enabled && !preset) throw new AuphonicError('Choose the Auphonic preset to use');
  await db.query(
    `UPDATE podcasts SET auphonic_enabled = $2, auphonic_preset = $3, auphonic_preset_name = $4, auphonic_transcripts = $5, auphonic_chapters = $6, auphonic_shownotes = $7 WHERE id = $1`,
    [podcastId, enabled, preset, presetName, transcripts, chapters, shownotes],
  );
}

// ───────────── building the production ─────────────

/**
 * The output files: the preset's own (transcripts, other formats, as set up in Auphonic), with its MP3
 * replaced by ours (128 kbps stereo). Sending output_files replaces the preset's list, so it's copied here.
 */
async function outputFilesFor(config: Config, preset: string | null): Promise<Record<string, unknown>[]> {
  const ours = { format: 'mp3', bitrate: '128', mono_mixdown: false };
  let theirs: Record<string, unknown>[] = [];
  if (preset) {
    try {
      const p = await call<{ output_files?: Record<string, unknown>[] }>(config, 'GET', `/api/preset/${encodeURIComponent(preset)}.json`);
      theirs = (p?.output_files ?? []).map((f) => {
        const out: Record<string, unknown> = {};
        for (const k of ['format', 'ending', 'bitrate', 'suffix', 'mono_mixdown', 'split_on_chapters']) {
          if (f[k] !== null && f[k] !== undefined && f[k] !== '') out[k] = f[k];
        }
        return out;
      }).filter((f) => f.format && f.format !== 'mp3');
    } catch {
      /* the preset couldn't be read: just the MP3 (speech recognition still adds transcripts) */
    }
  }
  return [ours, ...theirs];
}

const plain = (html: string | null) =>
  (html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();

const hms = (s: number) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), sec = Math.floor((ms % 60_000) / 1000), rest = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(rest).padStart(3, '0')}`;
};

/** "en-us" → "en-US"; Auphonic takes codes like "en" or "de-DE". */
const speechLanguage = (lang: string | null) => {
  if (!lang) return 'en';
  const [a, b] = lang.split('-');
  return b ? `${a!.toLowerCase()}-${b.toUpperCase()}` : a!.toLowerCase();
};

interface EpisodeData {
  id: string; title: string; description: string | null; link: string | null; itunes_episode: number | null; pub_date: Date | null;
  itunes_image_url: string | null; status: string; enclosure_url: string | null; enclosure_media_id: string | null;
}
interface ShowData {
  slug: string; title: string; itunes_author: string | null; itunes_owner_name: string | null; link: string | null; image_url: string | null;
  language: string | null; auphonic_preset: string | null; auphonic_transcripts: boolean;
}

/**
 * The production request for an episode (exported for tests and for reviewing the mapping).
 * Only these fields are sent; everything else (genre, summary, URL, ...) comes from the preset.
 */
export async function productionRequest(db: Db, config: Config, podcastId: string, episodeId: string, inputUrl: string, ai?: AiOptions) {
  const e = (await maybeOne<EpisodeData>(db, `SELECT * FROM episodes WHERE id = $1 AND podcast_id = $2`, [episodeId, podcastId]))!;
  const s = (await maybeOne<ShowData>(db, `SELECT * FROM podcasts WHERE id = $1`, [podcastId]))!;
  const opts = ai ?? await aiOptions(db, podcastId);
  const metadata: Record<string, unknown> = {
    title: e.title,                           // Title ← episode title
    track: e.itunes_episode ?? undefined,     // Track ← episode number
    artist: s.itunes_author ?? undefined,     // Artist ← author name
    album: s.title,                           // Album ← podcast name
    publisher: s.itunes_owner_name ?? undefined, // Publisher ← owner name
    year: new Date().getFullYear(),           // Year ← the current year
  };
  for (const k of Object.keys(metadata)) if (metadata[k] === undefined || metadata[k] === '') delete metadata[k];

  const { chapters } = await getChapters(db, config, podcastId, episodeId);
  const outputFiles = await outputFilesFor(config, s.auphonic_preset);
  const req: Record<string, unknown> = {
    preset: s.auphonic_preset,
    metadata,
    input_file: inputUrl,
    output_basename: `${s.slug}-${(e.itunes_episode ? `${e.itunes_episode}-` : '')}${e.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || s.slug,
    output_files: outputFiles,
    action: 'start',
  };
  // Cover ← episode art (the show's art when the episode has none, as in the feed).
  const image = e.itunes_image_url ?? s.image_url;
  if (image) req.image = image;
  // Chapters ← the chapter editor (typed, imported from .txt/.json, or read from the MP3), unless Auphonic makes them.
  if (opts.chapters === 'ours' && chapters.length) {
    req.chapters = chapters.map((c) => ({ start: hms(c.startTime), title: c.title, ...(c.url ? { url: c.url } : {}), ...(c.img ? { image: c.img } : {}) }));
  }
  // Auphonic's automatic chapters and show notes are one feature that needs speech recognition.
  const auto = opts.chapters === 'auphonic' || opts.shownotes;
  if (s.auphonic_transcripts || auto) {
    req.speech_recognition = { language: speechLanguage(s.language), ...(auto ? { shownotes: true } : {}) };
  }
  // Transcript files aren't requested: Auphonic adds them itself when speech recognition is on, and its API
  // refuses several documented endings ("webvtt", "txt") when they're asked for. Whatever comes back (SRT or
  // VTT) is used, and the missing formats are made here.
  if (config.auphonicHookToken) req.webhook = `${config.publicBaseUrl}/hooks/auphonic/${config.auphonicHookToken}`;
  return req;
}

// ───────────── jobs ─────────────

interface Job {
  id: string; podcast_id: string; episode_id: string; original_media_id: string | null; production_uuid: string | null;
  status: 'starting' | 'processing' | 'importing' | 'done' | 'failed'; status_string: string | null; error: string | null;
  publish_intent: { pubDate: string | null } | null; created_at: Date; finished_at: Date | null;
  options: AiOptions | null; shownotes: Shownotes | null; shownotes_applied: boolean;
}

export interface Shownotes { long: string | null; brief: string | null; subtitle: string | null; tags: string[] }

export const RUNNING = ['starting', 'processing', 'importing'];

export async function latestJob(q: Queryable, episodeId: string): Promise<Job | null> {
  return maybeOne<Job>(q, `SELECT * FROM auphonic_jobs WHERE episode_id = $1 ORDER BY created_at DESC LIMIT 1`, [episodeId]);
}

export const isRunning = (j: Job | null) => !!j && RUNNING.includes(j.status);

/** What the episode editor shows. */
export async function processingView(q: Queryable, episodeId: string) {
  const j = await latestJob(q, episodeId);
  if (!j) return null;
  return {
    status: j.status, stage: j.status_string, error: j.error, publishWhenDone: !!j.publish_intent,
    startedAt: j.created_at, finishedAt: j.finished_at, hasOriginal: !!j.original_media_id,
    chapters: j.options?.chapters ?? 'ours', makesShownotes: !!j.options?.shownotes,
    shownotes: j.shownotes, shownotesApplied: j.shownotes_applied,
  };
}

/** The audio file to send: the kept original (reprocessing) or the episode's current upload. */
async function inputMedia(q: Queryable, config: Config, podcastId: string, e: EpisodeData, reprocess: boolean): Promise<{ id: string; url: string }> {
  if (reprocess) {
    const j = await maybeOne<{ original_media_id: string | null }>(
      q, `SELECT original_media_id FROM auphonic_jobs WHERE episode_id = $1 AND original_media_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [e.id],
    );
    if (j?.original_media_id) {
      const m = await maybeOne<{ id: string; public_path: string }>(q, `SELECT id, public_path FROM media_files WHERE id = $1 AND status = 'done'`, [j.original_media_id]);
      if (m) return { id: m.id, url: config.mediaBaseUrl + m.public_path };
    }
  }
  const m = e.enclosure_media_id
    ? await maybeOne<{ id: string; public_path: string; kind: string }>(q, `SELECT id, public_path, kind FROM media_files WHERE id = $1 AND status = 'done'`, [e.enclosure_media_id])
    : e.enclosure_url?.startsWith(config.mediaBaseUrl + '/')
      ? await maybeOne<{ id: string; public_path: string; kind: string }>(
        q, `SELECT id, public_path, kind FROM media_files WHERE podcast_id = $1 AND public_path = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
        [podcastId, e.enclosure_url.slice(config.mediaBaseUrl.length)])
      : null;
  if (!m) throw new AuphonicError('The episode’s audio isn’t stored on this site, so it can’t be sent to Auphonic');
  return { id: m.id, url: config.mediaBaseUrl + m.public_path };
}

const isPublicNow = (e: { status: string; pub_date: Date | null }) => e.status === 'published' && (!e.pub_date || new Date(e.pub_date).getTime() <= Date.now());

/**
 * Send an episode to Auphonic. `publishIntent` is set when Publish was chosen
 * for an episode that isn't public yet: it's published once processing is done.
 */
export async function startProcessing(db: Db, config: Config, podcastId: string, episodeId: string, opts: { reprocess?: boolean; mediaId?: string; publishIntent?: { pubDate: string | null } | null; ai?: { chapters?: unknown; shownotes?: unknown }; log?: (m: string) => void } = {}): Promise<void> {
  const running = await latestJob(db, episodeId);
  if (isRunning(running)) throw new AuphonicError('This episode is already being processed', 409);
  const e = await maybeOne<EpisodeData>(db, `SELECT * FROM episodes WHERE id = $1 AND podcast_id = $2`, [episodeId, podcastId]);
  if (!e) throw new AuphonicError('Episode not found', 404);
  const s = await showSettings(db, podcastId);
  if (!s.preset) throw new AuphonicError('Choose an Auphonic preset for this show first (Settings → Auphonic)');
  let input: { id: string; url: string };
  if (opts.mediaId) {
    // A new upload, not yet the episode's audio (it becomes that once processed).
    const m = /^[0-9a-f-]{36}$/i.test(opts.mediaId)
      ? await maybeOne<{ id: string; public_path: string; kind: string }>(db, `SELECT id, public_path, kind FROM media_files WHERE id = $1 AND podcast_id = $2 AND status = 'done'`, [opts.mediaId, podcastId])
      : null;
    if (!m || m.kind !== 'audio') throw new AuphonicError('That audio file wasn’t found. Upload it again.');
    input = { id: m.id, url: config.mediaBaseUrl + m.public_path };
  } else input = await inputMedia(db, config, podcastId, e, !!opts.reprocess);
  const ai = await aiOptions(db, podcastId, opts.ai);
  const job = await one<{ id: string }>(
    db,
    `INSERT INTO auphonic_jobs (podcast_id, episode_id, original_media_id, publish_intent, options) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [podcastId, episodeId, input.id, opts.publishIntent ? JSON.stringify(opts.publishIntent) : null, JSON.stringify(ai)],
  );
  try {
    const req = await productionRequest(db, config, podcastId, episodeId, input.url, ai);
    const p = await call<{ uuid: string; status_string?: string }>(config, 'POST', '/api/productions.json', req);
    await db.query(`UPDATE auphonic_jobs SET production_uuid = $2, status = 'processing', status_string = $3, updated_at = now() WHERE id = $1`, [job.id, p.uuid, p.status_string ?? null]);
  } catch (err) {
    await failJob(db, job.id, (err as Error).message);
    throw err;
  }
}

async function failJob(db: Db, jobId: string, error: string) {
  await db.query(`UPDATE auphonic_jobs SET status = 'failed', error = $2, updated_at = now(), finished_at = now() WHERE id = $1`, [jobId, error.slice(0, 2000)]);
}

/** Change (or drop) the "publish when processing finishes" wish for a running job. */
export async function setPublishIntent(db: Db, episodeId: string, intent: { pubDate: string | null } | null): Promise<boolean> {
  const j = await latestJob(db, episodeId);
  if (!isRunning(j)) return false;
  await db.query(`UPDATE auphonic_jobs SET publish_intent = $2, updated_at = now() WHERE id = $1`, [j!.id, intent ? JSON.stringify(intent) : null]);
  return true;
}

interface Production {
  uuid: string; status: number; status_string?: string; error_message?: string; warning_message?: string;
  output_files?: { format?: string; ending?: string; download_url?: string; filename?: string; size?: number }[];
  chapters?: { start?: string; start_output_sec?: number; start_sec?: number; title?: string; url?: string; image?: string }[];
  shownotes?: { summaries?: { long?: string[] | string; brief?: string[] | string; subtitle?: string[] | string }; tags?: string[] };
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const joined = (v: string[] | string | undefined) => (Array.isArray(v) ? v.join('\n\n') : v ?? '').trim() || null;

/** Auphonic's generated show notes, with the long summary as HTML paragraphs for the episode description. */
export function readShownotes(p: Pick<Production, 'shownotes'>): Shownotes | null {
  const sn = p.shownotes;
  const long = joined(sn?.summaries?.long);
  const brief = joined(sn?.summaries?.brief);
  const subtitle = joined(sn?.summaries?.subtitle);
  if (!long && !brief && !subtitle) return null;
  return {
    long: long ? long.split(/\n{2,}/).map((para) => `<p>${esc(para.trim()).replace(/\n/g, '<br>')}</p>`).join('\n') : null,
    brief, subtitle, tags: (sn?.tags ?? []).filter((t) => typeof t === 'string'),
  };
}

/** Put Auphonic's show notes into the episode's description (the editor's "Use these show notes"). */
export async function applyShownotes(db: Db, config: Config, podcastId: string, episodeId: string): Promise<void> {
  const j = await latestJob(db, episodeId);
  const html = j?.shownotes?.long ?? j?.shownotes?.brief;
  if (!j || !html) throw new AuphonicError('Auphonic didn’t write show notes for this episode', 404);
  await db.tx(async (q) => {
    await updateEpisode(q, config, podcastId, episodeId, { description: html });
    await q.query(`UPDATE auphonic_jobs SET shownotes_applied = true WHERE id = $1`, [j.id]);
  });
}

const checking = new Set<string>();

/** Look at a running job's production; import the results when it's done. Returns the job's status afterwards. */
export async function checkJob(db: Db, config: Config, jobId: string, log?: (m: string) => void): Promise<string> {
  if (checking.has(jobId)) return 'processing';
  checking.add(jobId);
  try {
    const j = await maybeOne<Job>(db, `SELECT * FROM auphonic_jobs WHERE id = $1`, [jobId]);
    if (!j || !isRunning(j) || !j.production_uuid) return j?.status ?? 'failed';
    const p = await call<Production>(config, 'GET', `/api/production/${encodeURIComponent(j.production_uuid)}.json`);
    if (p.status === STATUS_ERROR || STATUS_STOPPED.has(p.status)) {
      await failJob(db, j.id, `Auphonic: ${p.error_message || p.status_string || `status ${p.status}`}`);
      return 'failed';
    }
    if (p.status !== STATUS_DONE) {
      await db.query(`UPDATE auphonic_jobs SET status_string = $2, updated_at = now() WHERE id = $1`, [j.id, p.status_string ?? null]);
      return 'processing';
    }
    await db.query(`UPDATE auphonic_jobs SET status = 'importing', status_string = $2, updated_at = now() WHERE id = $1`, [j.id, p.status_string ?? 'Done']);
    try {
      await importResults(db, config, j, p, log);
      return 'done';
    } catch (err) {
      await failJob(db, j.id, `Getting the results from Auphonic failed: ${(err as Error).message}`);
      return 'failed';
    }
  } finally {
    checking.delete(jobId);
  }
}

const staging = (config: Config) => path.join(path.resolve(config.mediaDir), '.staging');

async function download(config: Config, url: string, dest: string): Promise<void> {
  const u = new URL(url);
  // The key goes in the address: Auphonic redirects downloads, and a header wouldn't survive the redirect.
  u.searchParams.set('bearer_token', config.auphonicKey ?? '');
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
}

const sha256Of = (file: string) => new Promise<string>((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

/** Store a downloaded file as one of the show's files; returns its media id. */
async function storeFile(db: Db, config: Config, podcastId: string, slug: string, file: string, kind: 'audio' | 'transcript', dir: string, name: string, mime: string): Promise<string> {
  const size = (await stat(file)).size;
  const sha = await sha256Of(file);
  const info = kind === 'audio' ? await probeFile(file, mime) : {};
  const publicPath = mediaPath(slug, dir, `${randomBytes(4).toString('hex')}-${name}`);
  const key = publicPath.slice(1);
  const store = activeStore(config);
  const { storagePath } = await store.putFile(key, file, { size, contentType: mime, sha256: sha });
  const m = await one<{ id: string }>(
    db,
    `INSERT INTO media_files (podcast_id, kind, storage_path, public_path, mime_type, bytes, sha256, status, storage_key, storage_provider, duration, original_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'done', $8, $9, $10, $11) RETURNING id`,
    [podcastId, kind, storagePath, publicPath, mime, size, sha, key, store.id, info.duration ?? null, name],
  );
  return m.id;
}

function srtCues(srt: string): { startTime: number; endTime: number; body: string }[] {
  const t = (s: string) => {
    const m = /(?:(\d+):)?(\d+):(\d+)[,.](\d+)/.exec(s); // SRT 00:00:01,000 or VTT 00:01.000
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0').slice(0, 3)) / 1000 : 0;
  };
  return srt.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/).flatMap((block) => {
    const lines = block.trim().split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) return [];
    const [a, b0] = lines[i]!.split('-->');
    const b = b0!.trim().split(/\s+/)[0]; // VTT cue settings may follow the end time
    const body = lines.slice(i + 1).join(' ').trim();
    return body ? [{ startTime: t(a!), endTime: t(b!), body: body.replace(/<[^>]+>/g, '') }] : [];
  });
}

/** SRT → Podcasting 2.0 JSON transcript. */
export function srtToJson(srt: string): string {
  return JSON.stringify({ version: '1.0.0', segments: srtCues(srt) }, null, 1);
}

/** WebVTT (or SRT) → SRT. */
export function vttToSrt(vtt: string): string {
  const ts = (s: number) => hms(s).replace('.', ',');
  return srtCues(vtt).map((c, i) => `${i + 1}\n${ts(c.startTime)} --> ${ts(c.endTime)}\n${c.body}`).join('\n\n') + '\n';
}

/** SRT → WebVTT. */
export function srtToVtt(srt: string): string {
  const ts = (s: number) => hms(s);
  return 'WEBVTT\n\n' + srtCues(srt).map((c) => `${ts(c.startTime)} --> ${ts(c.endTime)}\n${c.body}`).join('\n\n') + '\n';
}

/** SRT → plain text, one cue per line. */
export function srtToText(srt: string): string {
  return srtCues(srt).map((c) => c.body).join('\n') + '\n';
}

async function importResults(db: Db, config: Config, j: Job, p: Production, log?: (m: string) => void) {
  await mkdir(staging(config), { recursive: true });
  const files = p.output_files ?? [];
  const pick = (fn: (f: NonNullable<Production['output_files']>[number]) => boolean) => files.find((f) => f.download_url && fn(f));
  const mp3 = pick((f) => f.format === 'mp3' || f.ending === 'mp3');
  if (!mp3) throw new Error('Auphonic made no MP3 (check the output files)');
  const srt = pick((f) => f.ending === 'srt');
  const vtt = pick((f) => f.ending === 'webvtt' || f.ending === 'vtt');
  const txt = pick((f) => f.format === 'transcript' && f.ending === 'txt');
  log?.(`auphonic: production ${p.uuid} returned ${files.map((f) => `${f.format ?? '?'}/${f.ending ?? '?'}`).join(', ') || 'no files'}`);
  const { slug, language, auphonic_transcripts: wantTranscripts } = await one<{ slug: string; language: string | null; auphonic_transcripts: boolean }>(
    db, `SELECT slug, language, auphonic_transcripts FROM podcasts WHERE id = $1`, [j.podcast_id]);
  const tmp: string[] = [];
  const fetchTo = async (f: NonNullable<typeof mp3>) => {
    const dest = path.join(staging(config), `${randomBytes(8).toString('hex')}-${path.basename(f.filename ?? 'file')}`);
    tmp.push(dest);
    await download(config, f.download_url!, dest);
    return dest;
  };
  try {
    const base = (mp3.filename ?? 'episode.mp3').replace(/[^\w.-]+/g, '-');
    const audioId = await storeFile(db, config, j.podcast_id, slug, await fetchTo(mp3), 'audio', 'audio', base.endsWith('.mp3') ? base : `${base}.mp3`, 'audio/mpeg');
    const transcripts: Record<string, unknown>[] = [];
    const stem = base.replace(/\.mp3$/i, '');
    let srtText: string | null = null;
    const made = async (ext: string, content: string) => {
      const f = path.join(staging(config), `${randomBytes(8).toString('hex')}.${ext}`);
      tmp.push(f);
      await writeFile(f, content);
      return f;
    };
    // Auphonic's SRT, or one made from its VTT; then VTT, JSON and TXT (whichever weren't sent) from the SRT.
    const vttFetched = wantTranscripts && vtt ? await fetchTo(vtt) : null;
    const srtFile = !wantTranscripts ? null : srt ? await fetchTo(srt) : vttFetched ? await made('srt', vttToSrt(await readFile(vttFetched, 'utf8'))) : null;
    if (srtFile) {
      srtText = await readFile(srtFile, 'utf8');
      if (!srtCues(srtText).length) srtText = null;
    }
    if (srtFile && srtText) {
      transcripts.push({ mediaId: await storeFile(db, config, j.podcast_id, slug, srtFile, 'transcript', 'transcripts', `${stem}.srt`, 'application/x-subrip'), type: 'application/x-subrip', rel: 'captions' });
    }
    const vttFile = vttFetched ?? (srtText ? await made('vtt', srtToVtt(srtText)) : null);
    if (vttFile) {
      transcripts.push({ mediaId: await storeFile(db, config, j.podcast_id, slug, vttFile, 'transcript', 'transcripts', `${stem}.vtt`, 'text/vtt'), type: 'text/vtt', rel: 'captions' });
    }
    if (srtText) {
      const jf = await made('json', srtToJson(srtText));
      transcripts.push({ mediaId: await storeFile(db, config, j.podcast_id, slug, jf, 'transcript', 'transcripts', `${stem}.json`, 'application/json'), type: 'application/json' });
    }
    const txtFile = !wantTranscripts ? null : txt ? await fetchTo(txt) : srtText ? await made('txt', srtToText(srtText)) : null;
    if (txtFile) {
      transcripts.push({ mediaId: await storeFile(db, config, j.podcast_id, slug, txtFile, 'transcript', 'transcripts', `${stem}.txt`, 'text/plain'), type: 'text/plain' });
    }
    for (const t of transcripts) t.language = language ?? null;

    const e = (await maybeOne<{ status: string; pub_date: Date | null; description: string | null }>(db, `SELECT status, pub_date, description FROM episodes WHERE id = $1`, [j.episode_id]))!;
    const input: Record<string, unknown> = { enclosure: { mediaId: audioId } };
    if (transcripts.length) input.transcripts = transcripts;
    // Show notes Auphonic wrote fill an empty description; otherwise they wait in the editor to be used or ignored.
    const notes = j.options?.shownotes ? readShownotes(p) : null;
    const fill = !!notes && !plain(e.description) && !!(notes.long ?? notes.brief);
    if (fill) input.description = notes!.long ?? notes!.brief;
    if (j.publish_intent && !isPublicNow(e)) {
      const when = j.publish_intent.pubDate && Date.parse(j.publish_intent.pubDate) > Date.now() ? j.publish_intent.pubDate : null;
      input.status = 'published';
      input.pubDate = when;
    }
    // Chapters: Auphonic's replace the editor's when the podcaster chose them; otherwise they only fill an empty list.
    const have = await getChapters(db, config, j.podcast_id, j.episode_id);
    const found = (p.chapters ?? []).filter((c) => c.title);
    if (found.length && (j.options?.chapters === 'auphonic' || !have.chapters.length)) {
      const list = found.map((c) => ({ startTime: c.start_output_sec ?? c.start_sec ?? 0, title: c.title!, url: c.url ?? null, img: c.image ?? null }));
      const droppedCh = await saveChapters(db, config, j.podcast_id, j.episode_id, list).catch((err) => { log?.(`auphonic chapters: ${(err as Error).message}`); return []; });
      await pruneMedia(db, config, j.podcast_id, droppedCh, log);
    }
    const dropped = await db.tx(async (q) => {
      const r = await updateEpisode(q, config, j.podcast_id, j.episode_id, input);
      await q.query(`UPDATE auphonic_jobs SET status = 'done', error = NULL, shownotes = $2, shownotes_applied = $3, updated_at = now(), finished_at = now() WHERE id = $1`,
        [j.id, notes ? JSON.stringify(notes) : null, fill]);
      return r.dropped;
    });
    await pruneMedia(db, config, j.podcast_id, dropped, log);

    log?.(`auphonic: episode ${j.episode_id} processed`);
  } finally {
    for (const f of tmp) await rm(f, { force: true });
  }
}

/** Auphonic's callback: check the production it names. */
export async function handleWebhook(db: Db, config: Config, uuid: string, log?: (m: string) => void): Promise<boolean> {
  const j = await maybeOne<{ id: string }>(db, `SELECT id FROM auphonic_jobs WHERE production_uuid = $1 ORDER BY created_at DESC LIMIT 1`, [uuid]);
  if (!j) return false;
  void checkJob(db, config, j.id, log).catch((e) => log?.(`auphonic check: ${(e as Error).message}`));
  return true;
}

/** Every minute: check running productions (in case a callback didn't arrive). */
export function startAuphonicWorker(deps: { db: Db; config: Config; log?: (m: string) => void }, everyMs = 60_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running || !deps.config.auphonicKey) return;
    running = true;
    void (async () => {
      try {
        const { rows } = await deps.db.query<{ id: string }>(
          `SELECT id FROM auphonic_jobs WHERE status IN ('processing', 'importing') AND production_uuid IS NOT NULL ORDER BY updated_at LIMIT 20`,
        );
        for (const r of rows) await checkJob(deps.db, deps.config, r.id, deps.log).catch((e) => deps.log?.(`auphonic check: ${(e as Error).message}`));
        // A job stuck 'starting' (the app restarted mid-request) is marked failed.
        await deps.db.query(`UPDATE auphonic_jobs SET status = 'failed', error = 'Sending to Auphonic was interrupted. Use Reprocess to try again.', finished_at = now()
                              WHERE status = 'starting' AND updated_at < now() - interval '10 minutes'`);
      } finally {
        running = false;
      }
    })();
  }, everyMs);
  return { stop: () => clearInterval(timer) };
}
