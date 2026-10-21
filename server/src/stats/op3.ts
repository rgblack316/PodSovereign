/**
 * OP3 (Open Podcast Prefix Project) stats for shows that use the OP3 prefix.
 * https://op3.dev/api/docs
 *
 * The show is found on OP3 by its podcast:guid (so a show moved here keeps
 * its history), else by its feed address; the OP3 show ID is then saved.
 * Results are cached for a while, since OP3's counts update about hourly.
 */
import type { Config } from '../config.js';
import { maybeOne, type Db } from '../db/db.js';
import { feedPath } from '../urls.js';

export class Op3Error extends Error {
  constructor(message: string, readonly status = 502, readonly code?: 'no_token' | 'not_found' | 'bad_token') {
    super(message);
  }
}

const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { at: number; data: Op3Stats }>();
export const clearOp3Cache = () => cache.clear();

export interface Op3Stats {
  showUuid: string;
  title: string | null;
  statsPageUrl: string | null;
  asOf: string | null;
  fetchedAt: string;
  monthlyDownloads: number | null;
  weeklyAvgDownloads: number | null;
  /** Last 4 full weeks, oldest first. */
  weeklyDownloads: number[];
  episodes: { itemGuid: string; title: string | null; pubdate: string | null; downloads1: number | null; downloads3: number | null; downloads7: number | null; downloads30: number | null; downloadsAll: number | null }[];
  /** Last three calendar months, most downloads first. */
  apps: { name: string; downloads: number }[];
}

async function op3Get<T>(config: Config, token: string, path: string, params: Record<string, string> = {}): Promise<{ status: number; body: T | null }> {
  const url = new URL(config.op3ApiUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Op3Error(`Couldn’t reach OP3: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: T | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) throw new Op3Error('OP3 didn’t accept the API token. Check it in Site settings → OP3 stats.', 502, 'bad_token');
  if (res.status !== 200 && res.status !== 404) {
    const msg = (body as { error?: string } | null)?.error ?? text.slice(0, 200);
    throw new Op3Error(`OP3 answered ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return { status: res.status, body };
}

/** Is this token accepted? (Looks up a show ID that doesn't exist: 404 means the token worked.) */
export async function testOp3Token(config: Config, token: string): Promise<void> {
  await op3Get(config, token, '/shows/00000000000000000000000000000000');
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

interface ShowInfo { showUuid: string; title?: string; podcastGuid?: string; statsPageUrl?: string }

async function findShow(config: Config, token: string, guid: string | null, feedUrl: string): Promise<ShowInfo | null> {
  for (const key of [guid, b64url(feedUrl)]) {
    if (!key) continue;
    const r = await op3Get<ShowInfo>(config, token, `/shows/${encodeURIComponent(key)}`);
    if (r.status === 200 && r.body?.showUuid) return r.body;
  }
  return null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function op3Stats(db: Db, config: Config, podcastId: string, opts: { refresh?: boolean } = {}): Promise<Op3Stats> {
  const token = config.op3Token;
  if (!token) throw new Op3Error('OP3 stats aren’t set up yet: an administrator adds an OP3 API token in Site settings.', 409, 'no_token');
  const hit = cache.get(podcastId);
  if (hit && !opts.refresh && Date.now() - hit.at < CACHE_MS) return hit.data;

  const p = (await maybeOne<{ slug: string; podcast_guid: string | null; op3_show_uuid: string | null }>(
    db, `SELECT slug, podcast_guid, op3_show_uuid FROM podcasts WHERE id = $1`, [podcastId],
  ))!;
  let show: ShowInfo | null = null;
  if (p.op3_show_uuid) {
    const r = await op3Get<ShowInfo>(config, token, `/shows/${p.op3_show_uuid}`);
    if (r.status === 200 && r.body?.showUuid) show = r.body;
  }
  show ??= await findShow(config, token, p.podcast_guid, config.publicBaseUrl + feedPath(p.slug));
  if (!show) {
    throw new Op3Error('OP3 hasn’t counted any downloads for this show yet. Stats appear once listeners download episodes through the OP3 prefix (usually within a day).', 404, 'not_found');
  }
  if (show.showUuid !== p.op3_show_uuid) await db.query(`UPDATE podcasts SET op3_show_uuid = $2 WHERE id = $1`, [podcastId, show.showUuid]);

  const id = show.showUuid;
  type Counts = { asof?: string; showDownloadCounts?: Record<string, { monthlyDownloads?: number; weeklyAvgDownloads?: number; weeklyDownloads?: number[] }> };
  type Eps = { episodes?: Record<string, unknown>[] };
  type Apps = { appDownloads?: Record<string, number> };
  const [counts, eps, apps] = await Promise.all([
    op3Get<Counts>(config, token, '/queries/show-download-counts', { showUuid: id }),
    op3Get<Eps>(config, token, '/queries/episode-download-counts', { showUuid: id }),
    op3Get<Apps>(config, token, '/queries/top-apps-for-show', { showUuid: id }),
  ]);
  const c = counts.body?.showDownloadCounts?.[id];
  const data: Op3Stats = {
    showUuid: id,
    title: show.title ?? null,
    statsPageUrl: show.statsPageUrl ?? `https://op3.dev/show/${id}`,
    asOf: counts.body?.asof ?? null,
    fetchedAt: new Date().toISOString(),
    monthlyDownloads: num(c?.monthlyDownloads),
    weeklyAvgDownloads: num(c?.weeklyAvgDownloads),
    weeklyDownloads: Array.isArray(c?.weeklyDownloads) ? c!.weeklyDownloads!.map((n) => num(n) ?? 0) : [],
    episodes: (eps.body?.episodes ?? []).map((e) => ({
      itemGuid: String(e.itemGuid ?? ''),
      title: typeof e.title === 'string' ? e.title : null,
      pubdate: typeof e.pubdate === 'string' ? e.pubdate : null,
      downloads1: num(e.downloads1), downloads3: num(e.downloads3), downloads7: num(e.downloads7),
      downloads30: num(e.downloads30), downloadsAll: num(e.downloadsAll),
    })),
    apps: Object.entries(apps.body?.appDownloads ?? {})
      .map(([name, downloads]) => ({ name, downloads: num(downloads) ?? 0 }))
      .sort((a, b) => b.downloads - a.downloads),
  };
  cache.set(podcastId, { at: Date.now(), data });
  return data;
}
