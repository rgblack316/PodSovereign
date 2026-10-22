/**
 * OP3 (Open Podcast Prefix Project) stats for shows that use the OP3 prefix.
 * https://op3.dev/api/docs
 *
 * The show is found on OP3 by its podcast:guid (so a show moved here keeps
 * its history), else by its feed address; the OP3 show ID is then saved.
 *
 * Numbers are fetched on a schedule (every 6 hours per show, one show at a
 * time) and saved in the database; the dashboard only reads what's saved.
 * Each part (totals, episodes, apps, daily records) is fetched and saved on
 * its own, so one slow OP3 query doesn't hold up or break the others.
 */
import type { Config } from '../config.js';
import { maybeOne, type Db } from '../db/db.js';
import { feedPath } from '../urls.js';

export class Op3Error extends Error {
  constructor(message: string, readonly status = 502, readonly code?: 'no_token' | 'not_found' | 'bad_token') {
    super(message);
  }
}

/** How often each show's numbers are refreshed from OP3. */
export const REFRESH_EVERY_MS = 6 * 60 * 60_000;
/** A Refresh button press is ignored when the last refresh started this recently. */
const MANUAL_MIN_MS = 15 * 60_000;
/** Timeouts: OP3's summary queries and record pages can take a while on busy shows. */
export const op3Timeouts = { query: 90_000, page: 120_000 };

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

async function op3Get<T>(config: Config, token: string, path: string, params: Record<string, string> = {}, opts: { timeoutMs?: number; retries?: number } = {}): Promise<{ status: number; body: T | null }> {
  const url = new URL(config.op3ApiUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const retries = opts.retries ?? 1;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    } catch (e) {
      if (attempt < retries) continue;
      const timedOut = (e as Error).name === 'TimeoutError';
      throw new Op3Error(timedOut ? `OP3 took too long to answer (over ${Math.round((opts.timeoutMs ?? 30_000) / 1000)} seconds)` : `Couldn’t reach OP3: ${(e as Error).message}`);
    }
    const text = await res.text();
    let body: T | null = null;
    try {
      body = text ? (JSON.parse(text) as T) : null;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || res.status === 403) throw new Op3Error('OP3 didn’t accept the API token. Check it in Site settings → OP3 stats.', 502, 'bad_token');
    if (res.status >= 500 && attempt < retries) continue;
    if (res.status !== 200 && res.status !== 404) {
      const msg = (body as { error?: string } | null)?.error ?? text.slice(0, 200);
      throw new Op3Error(`OP3 answered ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return { status: res.status, body };
  }
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

const refreshing = new Set<string>();
export const isRefreshing = (podcastId: string) => refreshing.has(podcastId);

async function saveSummary(db: Db, podcastId: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  await db.query(
    `INSERT INTO op3_summary (podcast_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')})
     ON CONFLICT (podcast_id) DO UPDATE SET ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`,
    [podcastId, ...keys.map((k) => (cols[k] !== null && typeof cols[k] === 'object' && !(cols[k] instanceof Date) ? JSON.stringify(cols[k]) : cols[k]))],
  );
}

/**
 * Fetch one show's numbers from OP3 and save them: totals, episodes and apps
 * (each saved as it arrives, or its error saved), then the daily records.
 */
export async function refreshOp3(db: Db, config: Config, podcastId: string, opts: { now?: Date; log?: (m: string) => void; pageSize?: number; maxMs?: number } = {}): Promise<void> {
  if (refreshing.has(podcastId)) return;
  refreshing.add(podcastId);
  try {
    const token = needToken(config);
    await db.query(`UPDATE podcasts SET op3_refreshed_at = $2 WHERE id = $1`, [podcastId, opts.now ?? new Date()]);
    let show: ShowInfo;
    try {
      show = await resolveShow(db, config, token, podcastId);
      await db.query(`UPDATE podcasts SET op3_error = NULL, op3_error_code = NULL WHERE id = $1`, [podcastId]);
    } catch (e) {
      await db.query(`UPDATE podcasts SET op3_error = $2, op3_error_code = $3 WHERE id = $1`, [podcastId, (e as Error).message, e instanceof Op3Error ? e.code ?? null : null]);
      throw e;
    }
    const id = show.showUuid;
    await saveSummary(db, podcastId, { title: show.title ?? null, stats_page_url: show.statsPageUrl ?? `https://op3.dev/show/${id}` });
    const part = async (name: 'counts' | 'episodes' | 'apps', fn: () => Promise<unknown>) => {
      try {
        await saveSummary(db, podcastId, { [name]: await fn(), [`${name}_at`]: new Date(), [`${name}_error`]: null });
      } catch (e) {
        await saveSummary(db, podcastId, { [`${name}_error`]: (e as Error).message });
        opts.log?.(`op3 ${name} for ${podcastId}: ${(e as Error).message}`);
      }
    };
    type Counts = { asof?: string; showDownloadCounts?: Record<string, { monthlyDownloads?: number; weeklyAvgDownloads?: number; weeklyDownloads?: number[] }> };
    type Eps = { episodes?: Record<string, unknown>[] };
    type Apps = { appDownloads?: Record<string, number> };
    // One after another: gentler on OP3 than all at once, and each is saved as soon as it arrives.
    await part('counts', async () => {
      const r = await op3Get<Counts>(config, token, '/queries/show-download-counts', { showUuid: id }, { timeoutMs: op3Timeouts.query });
      const c = r.body?.showDownloadCounts?.[id];
      return {
        asof: r.body?.asof ?? null,
        monthlyDownloads: num(c?.monthlyDownloads),
        weeklyAvgDownloads: num(c?.weeklyAvgDownloads),
        weeklyDownloads: Array.isArray(c?.weeklyDownloads) ? c!.weeklyDownloads!.map((n) => num(n) ?? 0) : [],
      };
    });
    await part('episodes', async () => {
      const r = await op3Get<Eps>(config, token, '/queries/episode-download-counts', { showUuid: id }, { timeoutMs: op3Timeouts.query });
      return (r.body?.episodes ?? []).map((e) => ({
        itemGuid: String(e.itemGuid ?? ''),
        title: typeof e.title === 'string' ? e.title : null,
        pubdate: typeof e.pubdate === 'string' ? e.pubdate : null,
        downloads1: num(e.downloads1), downloads3: num(e.downloads3), downloads7: num(e.downloads7),
        downloads30: num(e.downloads30), downloadsAll: num(e.downloadsAll),
      }));
    });
    await part('apps', async () => {
      const r = await op3Get<Apps>(config, token, '/queries/top-apps-for-show', { showUuid: id }, { timeoutMs: op3Timeouts.query });
      return Object.entries(r.body?.appDownloads ?? {})
        .map(([name, downloads]) => ({ name, downloads: num(downloads) ?? 0 }))
        .sort((x, y) => y.downloads - x.downloads);
    });
    await syncOp3Daily(db, config, podcastId, { now: opts.now, pageSize: opts.pageSize, maxMs: opts.maxMs, showUuid: id }).catch((e) => opts.log?.(`op3 daily for ${podcastId}: ${(e as Error).message}`));
  } finally {
    refreshing.delete(podcastId);
  }
}

export interface Op3State {
  refreshing: boolean;
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  /** The show couldn't be looked up on OP3 (not_found, bad_token…). */
  error: string | null;
  errorCode: string | null;
  title: string | null;
  statsPageUrl: string | null;
  counts: { asof: string | null; monthlyDownloads: number | null; weeklyAvgDownloads: number | null; weeklyDownloads: number[] } | null;
  countsAt: string | null;
  countsError: string | null;
  episodes: Op3Stats['episodes'];
  episodesAt: string | null;
  episodesError: string | null;
  apps: Op3Stats['apps'];
  appsAt: string | null;
  appsError: string | null;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The saved numbers for the dashboard (no OP3 calls). A show that has never
 * been refreshed gets its first refresh started in the background.
 */
export async function op3State(db: Db, config: Config, podcastId: string, opts: { log?: (m: string) => void } = {}): Promise<Op3State> {
  needToken(config);
  const p = (await maybeOne<{ op3_refreshed_at: Date | null; op3_error: string | null; op3_error_code: string | null }>(
    db, `SELECT op3_refreshed_at, op3_error, op3_error_code FROM podcasts WHERE id = $1`, [podcastId],
  ))!;
  if (!p.op3_refreshed_at) startRefresh(db, config, podcastId, opts.log);
  const s = await maybeOne<Record<string, any>>(db, `SELECT * FROM op3_summary WHERE podcast_id = $1`, [podcastId]);
  return {
    refreshing: refreshing.has(podcastId) || !p.op3_refreshed_at,
    refreshedAt: iso(p.op3_refreshed_at),
    nextRefreshAt: p.op3_refreshed_at ? new Date(new Date(p.op3_refreshed_at).getTime() + REFRESH_EVERY_MS).toISOString() : null,
    error: p.op3_error,
    errorCode: p.op3_error_code,
    title: s?.title ?? null,
    statsPageUrl: s?.stats_page_url ?? null,
    counts: s?.counts ?? null,
    countsAt: iso(s?.counts_at),
    countsError: s?.counts_error ?? null,
    episodes: s?.episodes ?? [],
    episodesAt: iso(s?.episodes_at),
    episodesError: s?.episodes_error ?? null,
    apps: s?.apps ?? [],
    appsAt: iso(s?.apps_at),
    appsError: s?.apps_error ?? null,
  };
}

function startRefresh(db: Db, config: Config, podcastId: string, log?: (m: string) => void) {
  if (refreshing.has(podcastId)) return;
  void refreshOp3(db, config, podcastId, { log }).catch((e) => log?.(`op3 refresh ${podcastId}: ${(e as Error).message}`));
}

/** The Refresh button: refresh now, unless a refresh started in the last 15 minutes. Returns whether it started. */
export async function requestOp3Refresh(db: Db, config: Config, podcastId: string, opts: { log?: (m: string) => void } = {}): Promise<boolean> {
  needToken(config);
  if (refreshing.has(podcastId)) return false;
  const p = (await maybeOne<{ op3_refreshed_at: Date | null }>(db, `SELECT op3_refreshed_at FROM podcasts WHERE id = $1`, [podcastId]))!;
  if (p.op3_refreshed_at && Date.now() - new Date(p.op3_refreshed_at).getTime() < MANUAL_MIN_MS) return false;
  startRefresh(db, config, podcastId, opts.log);
  return true;
}

/**
 * Every few minutes: refresh the next show that's due (one at a time). Due =
 * never refreshed, last refreshed over 6 hours ago, or a year of history still
 * being read (picked up again after a short pause until it's complete).
 */
export async function refreshDueOp3(db: Db, config: Config, opts: { now?: Date; log?: (m: string) => void; pageSize?: number; maxMs?: number } = {}): Promise<string | null> {
  if (!config.op3Token || refreshing.size) return null;
  const now = opts.now ?? new Date();
  const due = await maybeOne<{ id: string }>(
    db,
    `SELECT p.id FROM podcasts p
      WHERE p.status = 'active'
        AND EXISTS (SELECT 1 FROM podcast_prefixes x WHERE x.podcast_id = p.id AND x.service_key = 'op3' AND x.enabled)
        AND (p.op3_refreshed_at IS NULL
             OR p.op3_refreshed_at < $1::timestamptz - make_interval(secs => $2)
             OR (p.op3_error_code IS NULL AND (p.op3_synced_until IS NULL OR p.op3_synced_until < $1::timestamptz - interval '1 day')
                 AND p.op3_refreshed_at < $1::timestamptz - interval '5 minutes'))
      ORDER BY p.op3_refreshed_at NULLS FIRST LIMIT 1`,
    [now, REFRESH_EVERY_MS / 1000],
  );
  if (!due) return null;
  await refreshOp3(db, config, due.id, opts).catch((e) => opts.log?.(`op3 refresh ${due.id}: ${(e as Error).message}`));
  return due.id;
}

export function startOp3Worker(deps: { db: Db; config: Config; log?: (m: string) => void }, everyMs = 5 * 60_000) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    refreshDueOp3(deps.db, deps.config, { log: deps.log })
      .catch((e) => deps.log?.(`op3 worker: ${(e as Error).message}`))
      .finally(() => (running = false));
  };
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, everyMs);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

// ───────────── daily downloads and countries ─────────────

const DAY_MS = 86_400_000;
const PAGE = 5_000;
/** How far back the first sync goes. */
export const HISTORY_DAYS = 366;
/** One sync stops after this long and carries on at the next refresh (the year of history can be large). */
const SYNC_MAX_MS = 10 * 60_000;
const syncing = new Set<string>();
const utcDay = (t: number) => new Date(Math.floor(t / DAY_MS) * DAY_MS);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

interface DownloadRow { time?: string; countryCode?: string | null }
interface DownloadsPage { rows?: DownloadRow[]; count?: number; continuationToken?: string | null }

/**
 * Sum OP3's download records into op3_daily, from where the last sync left
 * off up to now. The first sync reaches back HISTORY_DAYS. Progress is saved
 * after every page, so a timeout loses one page, not the whole run: the
 * next sync re-reads from the start of the last day it had (that day may
 * have been partly counted, so it's cleared and counted again).
 */
export async function syncOp3Daily(db: Db, config: Config, podcastId: string, opts: { now?: Date; maxPages?: number; pageSize?: number; maxMs?: number; showUuid?: string } = {}): Promise<void> {
  if (syncing.has(podcastId)) return;
  syncing.add(podcastId);
  const started = Date.now();
  try {
    const token = needToken(config);
    const now = (opts.now ?? new Date()).getTime();
    const showUuid = opts.showUuid ?? (await resolveShow(db, config, token, podcastId)).showUuid;
    const row = (await maybeOne<{ op3_synced_until: Date | null }>(db, `SELECT op3_synced_until FROM podcasts WHERE id = $1`, [podcastId]))!;
    const from = utcDay(row.op3_synced_until ? new Date(row.op3_synced_until).getTime() : now - HISTORY_DAYS * DAY_MS);
    const pageSize = opts.pageSize ?? PAGE;
    const maxPages = opts.maxPages ?? Infinity;
    const maxMs = opts.maxMs ?? SYNC_MAX_MS;
    let last: string | null = null;
    let continuationToken: string | null = null;
    let first = true;
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string> = { format: 'json', limit: String(pageSize), end: new Date(now).toISOString() };
      if (continuationToken) {
        params.continuationToken = continuationToken;
        params.start = from.toISOString();
      } else if (last) params.startAfter = last;
      else params.start = from.toISOString();
      const r = await op3Get<DownloadsPage>(config, token, `/downloads/show/${showUuid}`, params, { timeoutMs: op3Timeouts.page, retries: 1 });
      const rows = r.body?.rows ?? [];
      const counts = new Map<string, number>();
      for (const d of rows) {
        if (!d.time) continue;
        const key = `${d.time.slice(0, 10)}|${(d.countryCode ?? '').toUpperCase().slice(0, 2)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        last = d.time;
      }
      continuationToken = r.body?.continuationToken || null;
      const complete = rows.length < pageSize && !continuationToken;
      // Everything before the start of the last day read is fully counted.
      const until = complete ? new Date(now) : last ? utcDay(Date.parse(last)) : from;
      await db.tx(async (q) => {
        if (first) await q.query(`DELETE FROM op3_daily WHERE podcast_id = $1 AND day >= $2`, [podcastId, isoDay(from)]);
        const entries = [...counts];
        for (let i = 0; i < entries.length; i += 500) {
          const vals: unknown[] = [podcastId];
          const tuples = entries.slice(i, i + 500).map(([k, n]) => {
            const [day, country] = k.split('|');
            vals.push(day, country, n);
            return `($1, $${vals.length - 2}, $${vals.length - 1}, $${vals.length})`;
          });
          await q.query(
            `INSERT INTO op3_daily (podcast_id, day, country, downloads) VALUES ${tuples.join(', ')}
             ON CONFLICT (podcast_id, day, country) DO UPDATE SET downloads = op3_daily.downloads + EXCLUDED.downloads`,
            vals,
          );
        }
        await q.query(`UPDATE podcasts SET op3_synced_until = $2, op3_synced_at = now(), op3_sync_error = NULL WHERE id = $1`, [podcastId, until]);
      });
      first = false;
      if (complete || Date.now() - started > maxMs) break;
    }
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

/** Daily downloads and countries for the last `days` days, from what's saved. */
export async function op3Daily(db: Db, config: Config, podcastId: string, days: number, opts: { now?: Date } = {}): Promise<Op3Daily> {
  needToken(config);
  const now = (opts.now ?? new Date()).getTime();
  const p = (await maybeOne<{ op3_synced_until: Date | null; op3_synced_at: Date | null; op3_sync_error: string | null }>(
    db, `SELECT op3_synced_until, op3_synced_at, op3_sync_error FROM podcasts WHERE id = $1`, [podcastId],
  ))!;
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
    syncing: syncing.has(podcastId) || refreshing.has(podcastId),
    syncedUntil: p.op3_synced_until ? new Date(p.op3_synced_until).toISOString() : null,
    error: p.op3_sync_error,
  };
}
