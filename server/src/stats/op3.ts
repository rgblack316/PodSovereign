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

/** The show's OP3 ID: the saved one, else found by podcast:guid or feed address (and saved). */
async function resolveShow(db: Db, config: Config, token: string, podcastId: string): Promise<ShowInfo> {
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
  return show;
}

function needToken(config: Config): string {
  if (!config.op3Token) throw new Op3Error('OP3 stats aren’t set up yet: an administrator adds an OP3 API token in Site settings.', 409, 'no_token');
  return config.op3Token;
}

export async function op3Stats(db: Db, config: Config, podcastId: string, opts: { refresh?: boolean } = {}): Promise<Op3Stats> {
  const token = needToken(config);
  const hit = cache.get(podcastId);
  if (hit && !opts.refresh && Date.now() - hit.at < CACHE_MS) return hit.data;
  const show = await resolveShow(db, config, token, podcastId);
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

// ───────────── daily downloads and countries ─────────────

const DAY_MS = 86_400_000;
const PAGE = 20_000;
/** How far back the first sync goes. */
export const HISTORY_DAYS = 366;
const SYNC_EVERY_MS = 60 * 60_000;
const syncing = new Set<string>();
const utcDay = (t: number) => new Date(Math.floor(t / DAY_MS) * DAY_MS);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

interface DownloadRow { time?: string; countryCode?: string | null }
interface DownloadsPage { rows?: DownloadRow[]; count?: number; continuationToken?: string | null }

/**
 * Sum OP3's download records into op3_daily, from where the last sync left
 * off (re-reading that day, since it may have been partial) up to now.
 * The first sync reaches back HISTORY_DAYS. Runs one at a time per show.
 */
export async function syncOp3Daily(db: Db, config: Config, podcastId: string, opts: { now?: Date; maxPages?: number; pageSize?: number } = {}): Promise<void> {
  if (syncing.has(podcastId)) return;
  syncing.add(podcastId);
  try {
    const token = needToken(config);
    const now = (opts.now ?? new Date()).getTime();
    const { showUuid } = await resolveShow(db, config, token, podcastId);
    const row = (await maybeOne<{ op3_synced_until: Date | null }>(db, `SELECT op3_synced_until FROM podcasts WHERE id = $1`, [podcastId]))!;
    const from = utcDay(row.op3_synced_until ? new Date(row.op3_synced_until).getTime() : now - HISTORY_DAYS * DAY_MS);
    const counts = new Map<string, number>();
    let last: string | null = null;
    let continuationToken: string | null | undefined;
    let complete = false;
    const maxPages = opts.maxPages ?? 50;
    const pageSize = opts.pageSize ?? PAGE;
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { format: 'json', limit: String(pageSize), end: new Date(now).toISOString() };
      if (continuationToken) params.continuationToken = continuationToken;
      if (last && !continuationToken) params.startAfter = last;
      else params.start = from.toISOString();
      const r = await op3Get<DownloadsPage>(config, token, `/downloads/show/${showUuid}`, params);
      const rows = r.body?.rows ?? [];
      for (const d of rows) {
        if (!d.time) continue;
        const key = `${d.time.slice(0, 10)}|${(d.countryCode ?? '').toUpperCase().slice(0, 2)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        last = d.time;
      }
      continuationToken = r.body?.continuationToken || null;
      if (rows.length < pageSize && !continuationToken) {
        complete = true;
        break;
      }
    }
    // Days from `from` up to the last record read are now fully counted (all of them when complete).
    const until = complete ? new Date(now) : last ? new Date(last) : from;
    const lastFullDay = complete ? null : isoDay(utcDay(until.getTime()));
    await db.tx(async (q) => {
      await q.query(`DELETE FROM op3_daily WHERE podcast_id = $1 AND day >= $2`, [podcastId, isoDay(from)]);
      const entries = [...counts].filter(([k]) => lastFullDay === null || k.slice(0, 10) < lastFullDay);
      for (let i = 0; i < entries.length; i += 500) {
        const chunk = entries.slice(i, i + 500);
        const vals: unknown[] = [podcastId];
        const tuples = chunk.map(([k, n]) => {
          const [day, country] = k.split('|');
          vals.push(day, country, n);
          return `($1, $${vals.length - 2}, $${vals.length - 1}, $${vals.length})`;
        });
        await q.query(`INSERT INTO op3_daily (podcast_id, day, country, downloads) VALUES ${tuples.join(', ')}`, vals);
      }
      await q.query(`UPDATE podcasts SET op3_synced_until = $2, op3_synced_at = now(), op3_sync_error = NULL WHERE id = $1`,
        [podcastId, complete ? new Date(now) : new Date(`${lastFullDay}T00:00:00Z`)]);
    });
  } catch (e) {
    await db.query(`UPDATE podcasts SET op3_sync_error = $2, op3_synced_at = now() WHERE id = $1`, [podcastId, (e as Error).message]).catch(() => {});
    throw e;
  } finally {
    syncing.delete(podcastId);
  }
}

export interface Op3Daily {
  days: { day: string; downloads: number }[];
  countries: { code: string; downloads: number }[];
  total: number;
  from: string;
  to: string;
  syncing: boolean;
  /** Downloads are summed up to here. */
  syncedUntil: string | null;
  error: string | null;
}

/**
 * Daily downloads and countries for the last `days` days. Starts a sync in
 * the background when the numbers are more than an hour old (the response
 * says so; ask again in a few seconds).
 */
export async function op3Daily(db: Db, config: Config, podcastId: string, days: number, opts: { now?: Date; log?: (m: string) => void } = {}): Promise<Op3Daily> {
  needToken(config);
  const now = (opts.now ?? new Date()).getTime();
  const p = (await maybeOne<{ op3_synced_until: Date | null; op3_synced_at: Date | null; op3_sync_error: string | null }>(
    db, `SELECT op3_synced_until, op3_synced_at, op3_sync_error FROM podcasts WHERE id = $1`, [podcastId],
  ))!;
  const stale = !p.op3_synced_at || now - new Date(p.op3_synced_at).getTime() > SYNC_EVERY_MS
    || (p.op3_synced_until && now - new Date(p.op3_synced_until).getTime() > 2 * DAY_MS && !p.op3_sync_error);
  if (stale && !syncing.has(podcastId)) {
    void syncOp3Daily(db, config, podcastId, { now: opts.now }).catch((e) => opts.log?.(`op3 sync ${podcastId}: ${(e as Error).message}`));
  }
  const fromDay = utcDay(now - (days - 1) * DAY_MS);
  const { rows: byDay } = await db.query<{ day: string; n: number }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(downloads)::int AS n FROM op3_daily WHERE podcast_id = $1 AND day >= $2 GROUP BY day`,
    [podcastId, isoDay(fromDay)],
  );
  const { rows: byCountry } = await db.query<{ code: string; n: number }>(
    `SELECT country AS code, sum(downloads)::int AS n FROM op3_daily WHERE podcast_id = $1 AND day >= $2 GROUP BY country ORDER BY n DESC`,
    [podcastId, isoDay(fromDay)],
  );
  const map = new Map(byDay.map((r) => [r.day, r.n]));
  const list: Op3Daily['days'] = [];
  for (let t = fromDay.getTime(); t <= now; t += DAY_MS) {
    const d = isoDay(new Date(t));
    list.push({ day: d, downloads: map.get(d) ?? 0 });
  }
  return {
    days: list,
    countries: byCountry.map((r) => ({ code: r.code, downloads: r.n })),
    total: list.reduce((a, d) => a + d.downloads, 0),
    from: isoDay(fromDay),
    to: isoDay(new Date(now)),
    syncing: syncing.has(podcastId),
    syncedUntil: p.op3_synced_until ? new Date(p.op3_synced_until).toISOString() : null,
    error: p.op3_sync_error,
  };
}
