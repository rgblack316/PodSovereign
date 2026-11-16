/**
 * PodChapters: AI chapters, made only when the podcaster asks for them.
 *
 * The episode's own transcript (usually Auphonic's, which costs nothing extra) is sent to PodChapters, so only
 * the chapters are paid for there (0.04 credits per audio minute); PodChapters never transcribes here.
 * The chapters come back to the chapter editor to be checked and saved, nothing is changed until then.
 *
 * Flow: find the episode's transcript → add the episode to PodChapters (once; later runs reuse it) →
 * upload the transcript → generate chapters. Everything is synchronous, so there is no callback.
 */
import type { Config } from '../config.js';
import { maybeOne, one, type Db, type Queryable } from '../db/db.js';
import { getEpisode } from '../publish/episodes.js';
import { storeFor } from '../storage/store.js';

export class PodChaptersError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export type TitleStyle = 'strict' | 'balance' | 'creative';
export type ChapterCount = 'fewer' | 'moderate' | 'more';
export interface ShowSettings { style: TitleStyle; count: ChapterCount; ads: boolean; links: boolean }

const STYLES: TitleStyle[] = ['strict', 'balance', 'creative'];
const COUNTS: ChapterCount[] = ['fewer', 'moderate', 'more'];
/** PodChapters' price for AI chapters, in credits per minute of audio. */
export const CREDITS_PER_MINUTE = 0.04;

interface ApiError { error?: { code?: string; message?: string; hint?: string } }

async function call<T>(config: Config, method: string, apiPath: string, body?: unknown, opts: { key?: string | null; timeoutMs?: number } = {}): Promise<T> {
  const key = opts.key === undefined ? config.podchaptersKey : opts.key;
  if (!key) throw new PodChaptersError('PodChapters isn’t set up: an administrator adds the API key in Site settings.', 409);
  let res: Response;
  try {
    res = await fetch(config.podchaptersUrl.replace(/\/+$/, '') + apiPath, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    throw new PodChaptersError(`Couldn’t reach PodChapters: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (res.ok) return json as T;
  const err = (json as ApiError | null)?.error;
  if (res.status === 401) throw new PodChaptersError('PodChapters didn’t accept the API key. Check it in Site settings → PodChapters.', 502);
  const said = [err?.message, err?.hint].filter(Boolean).join(' ') || text.slice(0, 200) || `status ${res.status}`;
  const e = new PodChaptersError(`PodChapters: ${said}`, res.status === 404 ? 404 : res.status === 409 ? 409 : 502);
  (e as PodChaptersError & { code?: string }).code = err?.code;
  throw e;
}

const codeOf = (e: unknown) => (e as { code?: string }).code;

/** Check a key; returns the plan and credits left. */
export async function testPodChaptersKey(config: Config, key: string): Promise<{ plan: string | null; credits: number; canMakeChapters: boolean }> {
  const a = await call<{ plan: { name: string | null; slug: string } | null; credits: { total_remaining: number }; access: { unavailable_tools: string[] } }>(config, 'GET', '/api/v1/account', undefined, { key });
  return { plan: a.plan?.name ?? a.plan?.slug ?? null, credits: a.credits.total_remaining, canMakeChapters: !a.access.unavailable_tools.includes('generate_chapters') };
}

// ───────────── show settings ─────────────

export async function showSettings(q: Queryable, podcastId: string): Promise<ShowSettings> {
  const r = await one<{ podchapters_style: TitleStyle; podchapters_count: ChapterCount; podchapters_ads: boolean; podchapters_links: boolean }>(
    q, `SELECT podchapters_style, podchapters_count, podchapters_ads, podchapters_links FROM podcasts WHERE id = $1`, [podcastId]);
  return { style: r.podchapters_style, count: r.podchapters_count, ads: r.podchapters_ads, links: r.podchapters_links };
}

export async function saveShowSettings(db: Db, podcastId: string, input: { style?: unknown; count?: unknown; ads?: unknown; links?: unknown }): Promise<void> {
  const cur = await showSettings(db, podcastId);
  const pick = <T extends string>(v: unknown, ok: T[], fallback: T, what: string): T => {
    if (v === undefined) return fallback;
    if (typeof v === 'string' && (ok as string[]).includes(v)) return v as T;
    throw new PodChaptersError(`${what} must be one of: ${ok.join(', ')}`, 400);
  };
  const style = pick(input.style, STYLES, cur.style, 'Title style');
  const count = pick(input.count, COUNTS, cur.count, 'Number of chapters');
  const ads = input.ads === undefined ? cur.ads : input.ads === true;
  const links = input.links === undefined ? cur.links : input.links === true;
  await db.query(`UPDATE podcasts SET podchapters_style = $2, podchapters_count = $3, podchapters_ads = $4, podchapters_links = $5 WHERE id = $1`, [podcastId, style, count, ads, links]);
}

// ───────────── the transcript ─────────────

interface MediaRow { public_path: string; storage_key: string | null; storage_provider: string | null }

/** Caption files first (they carry the timings the chapters need), then plain text. JSON and HTML aren't accepted. */
const TRANSCRIPT_ORDER = ['application/x-subrip', 'text/srt', 'text/vtt', 'text/plain'];

/** The episode's own transcript text, from the files stored on this site. */
export async function episodeTranscript(db: Db, config: Config, podcastId: string, episodeId: string): Promise<{ text: string; type: string }> {
  const ep = await getEpisode(db, podcastId, episodeId);
  const candidates = ep.transcripts
    .filter((t) => TRANSCRIPT_ORDER.includes(t.type))
    .sort((a, b) => TRANSCRIPT_ORDER.indexOf(a.type) - TRANSCRIPT_ORDER.indexOf(b.type));
  for (const t of candidates) {
    if (!t.url.startsWith(config.mediaBaseUrl + '/')) continue;
    const m = await maybeOne<MediaRow>(
      db, `SELECT public_path, storage_key, storage_provider FROM media_files WHERE podcast_id = $1 AND public_path = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
      [podcastId, t.url.slice(config.mediaBaseUrl.length)]);
    if (!m) continue;
    const text = (await storeFor(config, m.storage_provider).getBuffer(m.storage_key ?? m.public_path.slice(1))).toString('utf8');
    if (text.trim()) return { text, type: t.type };
  }
  throw new PodChaptersError(
    'This episode has no transcript yet. Turn on transcripts in the show’s Auphonic settings and process the episode, or add a transcript (SRT, VTT or text) to the episode first.', 409);
}

// ───────────── making chapters ─────────────

export interface MadeChapter { startTime: number; title: string; url: string | null; img: string | null; toc: boolean }

interface PcEpisode { id: string; filename: string }
interface PcChapter { start: number; title: string; url: string | null; image_url: string | null; toc: boolean }

const baseOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'episode.mp3';
  } catch {
    return 'episode.mp3';
  }
};

/** The credits it would take for an episode of this length. */
export const estimateCredits = (seconds: number | null | undefined) => (seconds ? Math.max(0.01, Math.round((seconds / 60) * CREDITS_PER_MINUTE * 100) / 100) : null);

/** The PodChapters copy of the episode: ours from before, or a new one made from the audio's public address. */
async function pcEpisode(db: Db, config: Config, podcastId: string, episodeId: string, audioUrl: string, force: boolean): Promise<string> {
  if (!force) {
    const saved = await maybeOne<{ pc_id: string }>(db, `SELECT pc_id FROM podchapters_episodes WHERE episode_id = $1`, [episodeId]);
    if (saved) return saved.pc_id;
  }
  const ep = await getEpisode(db, podcastId, episodeId);
  const show = await one<{ title: string; itunes_author: string | null }>(db, `SELECT title, itunes_author FROM podcasts WHERE id = $1`, [podcastId]);
  const filename = baseOf(audioUrl);
  const metadata: Record<string, unknown> = { title: ep.title, podcast_name: show.title };
  if (show.itunes_author) metadata.artist = show.itunes_author;
  if (ep.episode !== null) metadata.episode_number = ep.episode;
  let id: string;
  try {
    // PodChapters downloads the MP3 from its public address (a big file can take a minute or two).
    // Tags and presets are left alone: only chapters are wanted from here.
    id = (await call<PcEpisode>(config, 'POST', '/api/v1/episodes', { audio_url: audioUrl, filename, metadata, import_tags: false, apply_matching_presets: false }, { timeoutMs: 300_000 })).id;
  } catch (e) {
    if (codeOf(e) !== 'conflict') throw e;
    // The same file name is already in the account (an earlier run): use that one.
    const list = await call<{ episodes: PcEpisode[] }>(config, 'GET', `/api/v1/episodes?search=${encodeURIComponent(filename)}&page_size=100`);
    const same = list.episodes.find((x) => x.filename === filename);
    if (!same) throw e;
    id = same.id;
  }
  await db.query(`INSERT INTO podchapters_episodes (episode_id, pc_id) VALUES ($1, $2) ON CONFLICT (episode_id) DO UPDATE SET pc_id = EXCLUDED.pc_id, created_at = now()`, [episodeId, id]);
  return id;
}

/**
 * Make chapters for an episode. Nothing is saved here: the chapters go back to the editor to be checked.
 * The first one always starts at 00:00:00.
 */
export async function generateChapters(db: Db, config: Config, podcastId: string, episodeId: string, log?: (m: string) => void): Promise<{ chapters: MadeChapter[]; credits: number }> {
  if (!config.podchaptersKey) throw new PodChaptersError('PodChapters isn’t set up: an administrator adds the API key in Site settings.', 409);
  const ep = await getEpisode(db, podcastId, episodeId);
  if (!ep.enclosure?.url) throw new PodChaptersError('Add the episode’s audio first.', 409);
  const transcript = await episodeTranscript(db, config, podcastId, episodeId);
  const opts = await showSettings(db, podcastId);

  const run = async (force: boolean) => {
    const pc = await pcEpisode(db, config, podcastId, episodeId, ep.enclosure!.url, force);
    // The transcript is free to upload, so it's sent every time: it always matches the audio now stored here.
    await call(config, 'PUT', `/api/v1/episodes/${encodeURIComponent(pc)}/transcript`, { content: transcript.text }, { timeoutMs: 120_000 });
    return call<{ chapters: PcChapter[]; credits_spent: number }>(
      config, 'POST', `/api/v1/episodes/${encodeURIComponent(pc)}/chapters/generate`,
      { mode: 'suggest', title_style: opts.style, chapter_count: opts.count, detect_ads: opts.ads, link_urls: opts.links }, { timeoutMs: 240_000 });
  };
  let r: { chapters: PcChapter[]; credits_spent: number };
  try {
    r = await run(false);
  } catch (e) {
    // The PodChapters copy was deleted there: make a new one.
    if (!(e instanceof PodChaptersError) || e.status !== 404) throw e;
    r = await run(true);
  }
  const chapters = r.chapters
    .filter((c) => c.title)
    .map((c) => ({ startTime: c.start, title: c.title, url: c.url ?? null, img: c.image_url ?? null, toc: c.toc !== false }))
    .sort((a, b) => a.startTime - b.startTime);
  if (!chapters.length) throw new PodChaptersError('PodChapters didn’t find any chapters in this episode.', 502);
  chapters[0]!.startTime = 0;
  log?.(`podchapters: episode ${episodeId}: ${chapters.length} chapters, ${r.credits_spent} credits`);
  return { chapters, credits: r.credits_spent };
}
