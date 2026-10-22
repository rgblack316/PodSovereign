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
import { maybeOne, type Db, type Queryable } from '../db/db.js';
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
  allTime: AllTime;
}

export interface AllTime {
  /** Every download saved so far, and the first day counted. */
  downloads: number;
  firstDay: string | null;
  /** True once the show's whole OP3 history has been read (until then the total is still growing). */
  complete: boolean;
  /** While older history is being read: how far back it has got. */
  readingFrom: string | null;
}

async function allTimeOf(db: Db, podcastId: string): Promise<AllTime> {
  const r = (await maybeOne<{ n: number; first: string | null; h: Date | null; bu: Date | null; be: Date | null }>(
    db,
    `SELECT (SELECT coalesce(sum(downloads), 0)::int FROM op3_daily WHERE podcast_id = p.id) AS n,
            (SELECT to_char(min(day), 'YYYY-MM-DD') FROM op3_daily WHERE podcast_id = p.id AND downloads > 0) AS first,
            p.op3_history_at AS h, p.op3_backfill_until AS bu, p.op3_backfill_end AS be
       FROM podcasts p WHERE p.id = $1`,
    [podcastId],
  ))!;
  return { downloads: r.n, firstDay: r.first, complete: !!r.h && !r.be, readingFrom: r.be && r.bu ? new Date(r.bu).toISOString() : null };
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
    allTime: await allTimeOf(db, podcastId),
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
 * never refreshed, last refreshed over 6 hours ago, or history still being
 * read (picked up again after a short pause until it's complete).
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
             OR (p.op3_error_code IS NULL
                 AND (p.op3_synced_until IS NULL OR p.op3_synced_until < $1::timestamptz - interval '1 day' OR p.op3_backfill_end IS NOT NULL)
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
/** The first sync reads this far back, so recent numbers show quickly; older history is read after. */
export const HISTORY_DAYS = 366;
/** Before OP3 existed, so reading from here gets a show's whole OP3 history. */
export const OP3_EPOCH = new Date('2021-01-01T00:00:00Z');
/** The whole history is re-read this often, to pick up OP3's later corrections (bots found later, say). */
const REREAD_EVERY_MS = 30 * DAY_MS;
/** One sync stops after this long and carries on at the next run (a show's history can be large). */
const SYNC_MAX_MS = 10 * 60_000;
const syncing = new Set<string>();
const utcDay = (t: number) => new Date(Math.floor(t / DAY_MS) * DAY_MS);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const nextIsoDay = (day: string) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS));

interface DownloadRow { time?: string; countryCode?: string | null }
interface DownloadsPage { rows?: DownloadRow[]; count?: number; continuationToken?: string | null }

/**
 * Read OP3's download records from the start of `start`'s day up to `end`,
 * replacing the saved daily counts day by day as it goes: each day is
 * cleared just before its records are added, so what's saved stays shown
 * while it's re-read. Progress is saved after every page through `save`
 * (the start of the last day read, which may have been partly read; a later
 * run re-reads it). Returns whether it reached `end`.
 */
async function readRecords(db: Db, config: Config, a: {
  token: string; showUuid: string; podcastId: string; start: Date; end: Date; pageSize: number;
  budget: { pages: number; deadline: number };
  save: (q: Queryable, until: Date, complete: boolean) => Promise<void>;
}): Promise<boolean> {
  const startDay = utcDay(a.start.getTime());
  if (startDay.getTime() >= a.end.getTime()) {
    await db.tx((q) => a.save(q, a.end, true));
    return true;
  }
  const lastEndDay = isoDay(new Date(a.end.getTime() - 1));
  let cleared = isoDay(new Date(startDay.getTime() - DAY_MS)); // days after this one have been cleared in this run
  let last: string | null = null;
  let continuationToken: string | null = null;
  while (a.budget.pages > 0) {
    a.budget.pages--;
    const params: Record<string, string> = { format: 'json', limit: String(a.pageSize), end: a.end.toISOString() };
    if (continuationToken) {
      params.continuationToken = continuationToken;
      params.start = startDay.toISOString();
    } else if (last) params.startAfter = last;
    else params.start = startDay.toISOString();
    const r = await op3Get<DownloadsPage>(config, a.token, `/downloads/show/${a.showUuid}`, params, { timeoutMs: op3Timeouts.page, retries: 1 });
    const rows = r.body?.rows ?? [];
    const counts = new Map<string, number>();
    for (const d of rows) {
      if (!d.time) continue;
      const key = `${d.time.slice(0, 10)}|${(d.countryCode ?? '').toUpperCase().slice(0, 2)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      last = d.time;
    }
    continuationToken = r.body?.continuationToken || null;
    const complete = rows.length < a.pageSize && !continuationToken;
    // Days up to here are now read (or being read): clear the ones not yet cleared in this run.
    const clearTo = complete ? lastEndDay : last ? last.slice(0, 10) : cleared;
    await db.tx(async (q) => {
      if (clearTo > cleared) await q.query(`DELETE FROM op3_daily WHERE podcast_id = $1 AND day > $2 AND day <= $3`, [a.podcastId, cleared, clearTo]);
      const entries = [...counts];
      for (let i = 0; i < entries.length; i += 500) {
        const vals: unknown[] = [a.podcastId];
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
      await a.save(q, complete ? a.end : last ? utcDay(Date.parse(last)) : startDay, complete);
    });
    if (clearTo > cleared) cleared = clearTo;
    if (complete) return true;
    if (Date.now() > a.budget.deadline) return false;
  }
  return false;
}

/**
 * Bring the saved daily counts up to date: first from where the last sync
 * left off up to now (the very first sync reads the last HISTORY_DAYS), then
 * older history ("backfill") back to the start of OP3, with whatever time is
 * left. Every month or so the whole history is re-read. Saved as it goes, so
 * a timeout loses one page, not the whole run.
 */
export async function syncOp3Daily(db: Db, config: Config, podcastId: string, opts: { now?: Date; maxPages?: number; pageSize?: number; maxMs?: number; showUuid?: string } = {}): Promise<void> {
  if (syncing.has(podcastId)) return;
  syncing.add(podcastId);
  try {
    const token = needToken(config);
    const now = opts.now ?? new Date();
    const showUuid = opts.showUuid ?? (await resolveShow(db, config, token, podcastId)).showUuid;
    const budget = { pages: opts.maxPages ?? Infinity, deadline: Date.now() + (opts.maxMs ?? SYNC_MAX_MS) };
    const pageSize = opts.pageSize ?? PAGE;
    const row = (await maybeOne<{ op3_synced_until: Date | null; op3_backfill_until: Date | null; op3_backfill_end: Date | null; op3_history_at: Date | null }>(
      db, `SELECT op3_synced_until, op3_backfill_until, op3_backfill_end, op3_history_at FROM podcasts WHERE id = $1`, [podcastId],
    ))!;

    // 1. Recent: up to now.
    const firstSync = !row.op3_synced_until;
    const forwardStart = row.op3_synced_until ? new Date(row.op3_synced_until) : utcDay(now.getTime() - HISTORY_DAYS * DAY_MS);
    const forwardDone = await readRecords(db, config, {
      token, showUuid, podcastId, start: forwardStart, end: now, pageSize, budget,
      save: async (q, until, complete) => {
        await q.query(
          `UPDATE podcasts SET op3_synced_until = $2, op3_synced_at = now(), op3_sync_error = NULL,
                  op3_backfill_until = CASE WHEN $3 THEN $4::timestamptz ELSE op3_backfill_until END,
                  op3_backfill_end = CASE WHEN $3 THEN $5::timestamptz ELSE op3_backfill_end END
            WHERE id = $1`,
          // After the very first sync, read everything older than it.
          [podcastId, until, complete && firstSync, OP3_EPOCH, utcDay(forwardStart.getTime())],
        );
      },
    });
    if (!forwardDone) return;

    // 2. Older history, and the monthly re-read of all of it.
    let b = (await maybeOne<{ s: Date | null; e: Date | null; h: Date | null; u: Date }>(
      db, `SELECT op3_backfill_until AS s, op3_backfill_end AS e, op3_history_at AS h, op3_synced_until AS u FROM podcasts WHERE id = $1`, [podcastId],
    ))!;
    if (!b.e && (!b.h || now.getTime() - new Date(b.h).getTime() > REREAD_EVERY_MS)) {
      const end = utcDay(new Date(b.u).getTime());
      await db.query(`UPDATE podcasts SET op3_backfill_until = $2, op3_backfill_end = $3 WHERE id = $1`, [podcastId, OP3_EPOCH, end]);
      b = { ...b, s: OP3_EPOCH, e: end };
    }
    if (!b.e) return;
    await readRecords(db, config, {
      token, showUuid, podcastId, start: new Date(b.s ?? OP3_EPOCH), end: new Date(b.e), pageSize, budget,
      save: async (q, until, complete) => {
        if (complete) await q.query(`UPDATE podcasts SET op3_backfill_until = NULL, op3_backfill_end = NULL, op3_history_at = now(), op3_sync_error = NULL WHERE id = $1`, [podcastId]);
        else await q.query(`UPDATE podcasts SET op3_backfill_until = $2, op3_sync_error = NULL WHERE id = $1`, [podcastId, until]);
      },
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
  /** Every download saved so far, and the first day counted. */
  allTime: number;
  firstDay: string | null;
  /** True once the show's whole OP3 history has been read (until then allTime is still growing). */
  historyComplete: boolean;
  /** While older history is being read: how far back it has got. */
  backfillAt: string | null;
}

/** Daily downloads and countries for the last `days` days, from what's saved. */
export async function op3Daily(db: Db, config: Config, podcastId: string, days: number, opts: { now?: Date } = {}): Promise<Op3Daily> {
  needToken(config);
  const now = (opts.now ?? new Date()).getTime();
  const p = (await maybeOne<{ op3_synced_until: Date | null; op3_synced_at: Date | null; op3_sync_error: string | null; op3_backfill_until: Date | null; op3_backfill_end: Date | null; op3_history_at: Date | null }>(
    db, `SELECT op3_synced_until, op3_synced_at, op3_sync_error, op3_backfill_until, op3_backfill_end, op3_history_at FROM podcasts WHERE id = $1`, [podcastId],
  ))!;
  const all = await allTimeOf(db, podcastId);
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
    allTime: all.downloads,
    firstDay: all.firstDay,
    historyComplete: all.complete,
    backfillAt: all.readingFrom,
  };
}
