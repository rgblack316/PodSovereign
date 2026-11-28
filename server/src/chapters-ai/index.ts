/**
 * Chapter makers, chosen per request. Each provider turns an episode's transcript into chapters; nothing is saved
 * here, the chapter editor shows each draft to be checked first.
 */
import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/db.js';
import { one } from '../db/db.js';
import { getEpisode } from '../publish/episodes.js';
import { COUNTS, STYLES, PodChaptersError, episodeTranscript, estimateCredits, generateChapters, showSettings, type MadeChapter, type ShowSettings } from '../podchapters/podchapters.js';
import { GeminiError, geminiChapters } from './gemini.js';
import { parseCues } from './transcript.js';

export type ProviderId = 'podchapters' | 'gemini';
export const PROVIDER_IDS: ProviderId[] = ['podchapters', 'gemini'];
const LABELS: Record<ProviderId, string> = { podchapters: 'PodChapters', gemini: 'Gemini' };

export const isConfigured = (config: Config, id: ProviderId) => (id === 'podchapters' ? !!config.podchaptersKey : !!config.geminiKey);

/** Which providers a show has switched on. */
export async function enabledProviders(q: Queryable, podcastId: string): Promise<Record<ProviderId, boolean>> {
  const r = await one<{ chapters_podchapters: boolean; chapters_gemini: boolean }>(q, `SELECT chapters_podchapters, chapters_gemini FROM podcasts WHERE id = $1`, [podcastId]);
  return { podchapters: r.chapters_podchapters, gemini: r.chapters_gemini };
}

export async function saveEnabledProviders(db: Db, podcastId: string, input: unknown): Promise<void> {
  const cur = await enabledProviders(db, podcastId);
  const given = (input ?? {}) as Record<string, unknown>;
  const next = { podchapters: given.podchapters === undefined ? cur.podchapters : given.podchapters === true, gemini: given.gemini === undefined ? cur.gemini : given.gemini === true };
  if (!next.podchapters && !next.gemini) throw new PodChaptersError('Keep at least one chapter maker turned on.', 400);
  await db.query(`UPDATE podcasts SET chapters_podchapters = $2, chapters_gemini = $3 WHERE id = $1`, [podcastId, next.podchapters, next.gemini]);
}

/** The options sent with a request, filled in from the show's defaults. */
export function readOptions(input: unknown, defaults: ShowSettings): ShowSettings {
  const o = (input ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, ok: T[], d: T, what: string): T => {
    if (v === undefined) return d;
    if (typeof v === 'string' && (ok as string[]).includes(v)) return v as T;
    throw new PodChaptersError(`${what} must be one of: ${ok.join(', ')}`, 400);
  };
  return {
    style: pick(o.style, STYLES, defaults.style, 'Title style'),
    count: pick(o.count, COUNTS, defaults.count, 'Number of chapters'),
    ads: o.ads === undefined ? defaults.ads : o.ads === true,
    links: o.links === undefined ? defaults.links : o.links === true,
  };
}

/** What the chapter button needs: the makers this show uses, whether each is set up, the cost, and the default options. */
export async function providerMenu(db: Db, config: Config, podcastId: string, episodeId: string) {
  const ep = await getEpisode(db, podcastId, episodeId);
  const on = await enabledProviders(db, podcastId);
  return {
    configured: PROVIDER_IDS.some((id) => on[id] && isConfigured(config, id)),
    providers: PROVIDER_IDS.filter((id) => on[id]).map((id) => ({
      id,
      label: LABELS[id],
      configured: isConfigured(config, id),
      credits: id === 'podchapters' ? estimateCredits(ep.duration) : null,
    })),
    options: await showSettings(db, podcastId),
  };
}

export interface Made { provider: ProviderId; model: string | null; generatedAt: string; chapters: MadeChapter[]; credits: number | null }

export async function makeChapters(
  db: Db, config: Config, podcastId: string, episodeId: string, provider: ProviderId, input: unknown, log?: (m: string) => void,
): Promise<Made> {
  const on = await enabledProviders(db, podcastId);
  if (!on[provider]) throw new PodChaptersError(`${LABELS[provider]} isn’t turned on for this show. Turn it on in the show’s settings.`, 409);
  const options = readOptions(input, await showSettings(db, podcastId));
  const generatedAt = new Date().toISOString();
  if (provider === 'podchapters') {
    const r = await generateChapters(db, config, podcastId, episodeId, log, options);
    return { provider, model: null, generatedAt, chapters: r.chapters, credits: r.credits };
  }
  if (!config.geminiKey) throw new GeminiError('Gemini isn’t set up: an administrator adds the API key in Site settings.', 409);
  const ep = await getEpisode(db, podcastId, episodeId);
  const t = await episodeTranscript(db, config, podcastId, episodeId);
  const cues = parseCues(t.text);
  if (!cues.length) throw new GeminiError('This episode’s transcript has no timings. Chapters need an SRT or VTT transcript.', 409);
  const made = await geminiChapters(config, cues, t.text, options, ep.duration ?? null);
  log?.(`gemini: episode ${episodeId}: ${made.length} chapters (${config.geminiModel})`);
  return {
    provider, model: config.geminiModel, generatedAt, credits: null,
    chapters: made.map((c) => ({ startTime: c.startTime, title: c.title, url: c.url, img: null, toc: true })),
  };
}
