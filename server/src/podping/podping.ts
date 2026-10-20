/**
 * Podping (https://podping.org): when a feed changes, announce it on the Hive
 * blockchain so podcast apps and Podcast Index refresh it within seconds
 * instead of waiting for their next poll. Two ways to send:
 *
 *   hub    Podcast Index's open hub, no key: GET https://hub.podcastindex.org/pubnotify?url=<feed>&podping=1
 *          Podcast Index polls the feed right away and sends the podping for us.
 *   cloud  podping.cloud with an authorization token from Podcast Index; carries the
 *          reason (update / live / liveEnd) and medium.
 *
 * The site setting picks one (auto = cloud when a key is saved, otherwise hub).
 *
 * Changes are queued, and several changes to one feed in quick succession
 * collapse into a single ping.
 */
import type { Config } from '../config.js';
import { maybeOne, type Db, type Queryable } from '../db/db.js';
import { feedPath } from '../urls.js';

export type PingReason = 'update' | 'live' | 'liveEnd';

/** Mediums podping accepts; anything else is sent as "podcast". */
const MEDIUMS = new Set(['podcast', 'music', 'video', 'film', 'audiobook', 'newsletter', 'blog']);
const MAX_ATTEMPTS = 6;

/** Which way pings go out right now, or null when Podping is off for the site. */
export function podpingMethod(config: Config): 'hub' | 'cloud' | null {
  const mode = config.podpingMode ?? 'auto';
  if (mode === 'off') return null;
  if (mode === 'hub') return 'hub';
  if (mode === 'cloud') return config.podpingToken ? 'cloud' : null;
  return config.podpingToken ? 'cloud' : 'hub';
}

export const podpingEnabled = (config: Config) => podpingMethod(config) !== null;

export function podpingMedium(podcastMedium: string | null | undefined): string {
  const m = (podcastMedium ?? '').trim().toLowerCase();
  return MEDIUMS.has(m) ? m : 'podcast';
}

/**
 * Queue a ping for a podcast. No-op when Podping isn't configured on the server,
 * the show's own Podping switch is off, or the show is still importing.
 */
export async function queuePing(q: Queryable, config: Config, podcastId: string, reason: PingReason = 'update'): Promise<boolean> {
  if (!podpingEnabled(config)) return false;
  const p = await maybeOne<{ slug: string; status: string; podcast_medium: string | null; podping_enabled: boolean }>(
    q,
    `SELECT slug, status, podcast_medium, podping_enabled FROM podcasts WHERE id = $1`,
    [podcastId],
  );
  if (!p || p.status !== 'active' || !p.podping_enabled) return false;
  const r = await q.query(
    `INSERT INTO podping_queue (podcast_id, feed_url, reason, medium, next_try_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
     ON CONFLICT (podcast_id, reason) WHERE status = 'pending' DO NOTHING`,
    [podcastId, config.publicBaseUrl + feedPath(p.slug), reason, podpingMedium(p.podcast_medium), config.podpingDelaySec],
  );
  return r.rowCount > 0;
}

/**
 * Queue pings for podcasts with episodes whose publish time has now passed
 * (scheduled episodes going live). Returns the number of podcasts queued.
 */
export async function announceDueEpisodes(db: Db, config: Config): Promise<number> {
  const { rows } = await db.query<{ podcast_id: string }>(
    `UPDATE episodes SET announced_at = now()
      WHERE announced_at IS NULL AND status IN ('published', 'scheduled')
        AND (pub_date IS NULL OR pub_date <= now())
      RETURNING podcast_id`,
  );
  const ids = [...new Set(rows.map((r) => r.podcast_id))];
  if (ids.length) {
    // The cached feed predates these episodes.
    await db.query(
      `UPDATE podcasts SET feed_cache_xml = NULL, feed_cache_etag = NULL
        WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
      [JSON.stringify(ids)],
    );
  }
  let n = 0;
  for (const id of ids) if (await queuePing(db, config, id, 'update')) n++;
  return n;
}

interface QueueRow {
  id: string;
  feed_url: string;
  reason: PingReason;
  medium: string;
  attempts: number;
}

/** Send every due ping. Returns counts. */
export async function sendDuePings(
  db: Db,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; failed: number }> {
  const method = podpingMethod(config);
  if (!method) return { sent: 0, failed: 0 };
  const { rows } = await db.query<QueueRow>(
    `SELECT id, feed_url, reason, medium, attempts FROM podping_queue
      WHERE status = 'pending' AND next_try_at <= now() ORDER BY next_try_at LIMIT 50`,
  );
  let sent = 0;
  let failed = 0;
  for (const p of rows) {
    try {
      if (method === 'cloud') {
        const url = new URL(config.podpingUrl);
        url.searchParams.set('url', p.feed_url);
        url.searchParams.set('reason', p.reason);
        url.searchParams.set('medium', podpingMedium(p.medium));
        const res = await fetchImpl(url, {
          headers: { Authorization: config.podpingToken!, 'User-Agent': 'FeedHost/0.1 (+podping)' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (check the Podping key)' : ''}`);
      } else {
        // The hub reads the feed itself, so the reason and medium come from the feed.
        const url = new URL(config.podpingHubUrl);
        url.searchParams.set('url', p.feed_url);
        url.searchParams.set('podping', '1');
        const res = await fetchImpl(url, { headers: { 'User-Agent': 'FeedHost/0.1 (+podping)' }, signal: AbortSignal.timeout(15_000) });
        const body = await res.text().catch(() => '');
        if (!res.ok) throw new Error(`Podcast Index hub: HTTP ${res.status}`);
        let json: { status?: unknown; description?: unknown } | null = null;
        try {
          json = JSON.parse(body);
        } catch {
          /* not JSON: a 2xx is success */
        }
        if (json && (json.status === false || json.status === 'false')) {
          throw new Error(`Podcast Index hub: ${typeof json.description === 'string' ? json.description : 'refused'}`);
        }
      }
      await db.query(`UPDATE podping_queue SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [p.id]);
      sent++;
    } catch (e) {
      const attempts = p.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      // Back off 30s, 1m, 2m, 4m, 8m.
      await db.query(
        `UPDATE podping_queue SET attempts = $2, last_error = $3,
                status = CASE WHEN $4 THEN 'failed' ELSE 'pending' END,
                next_try_at = now() + make_interval(secs => $5)
          WHERE id = $1`,
        [p.id, attempts, (e as Error).message, giveUp, 30 * 2 ** (attempts - 1)],
      );
      failed++;
    }
  }
  return { sent, failed };
}

/** Turn a show's Podping switch on or off. Turning it on announces the feed once. */
export async function setShowPodping(q: Queryable, config: Config, podcastId: string, enabled: boolean): Promise<void> {
  const r = await maybeOne<{ was: boolean }>(
    q,
    `UPDATE podcasts p SET podping_enabled = $2, feed_cache_xml = NULL, feed_cache_etag = NULL
       FROM (SELECT podping_enabled AS was FROM podcasts WHERE id = $1) old
      WHERE p.id = $1 RETURNING old.was`,
    [podcastId, enabled],
  );
  if (enabled && r && !r.was) await queuePing(q, config, podcastId, 'update');
  if (!enabled) {
    await q.query(`DELETE FROM podping_queue WHERE podcast_id = $1 AND status = 'pending'`, [podcastId]);
  }
}

export async function latestPings(q: Queryable, podcastId: string) {
  const { rows } = await q.query(
    `SELECT reason, status, attempts, last_error AS "lastError", created_at AS "createdAt", sent_at AS "sentAt"
       FROM podping_queue WHERE podcast_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [podcastId],
  );
  return rows;
}

/** Background loop: announce newly-due episodes and send queued pings. */
export function startPodpingWorker(deps: { db: Db; config: Config; log?: (m: string) => void }, everyMs = 10_000) {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      await announceDueEpisodes(deps.db, deps.config);
      const r = await sendDuePings(deps.db, deps.config);
      if (r.sent || r.failed) deps.log?.(`podping: ${r.sent} sent, ${r.failed} failed`);
    } catch (e) {
      deps.log?.(`podping worker error: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(() => {
    if (!stopped) running = running.then(tick);
  }, everyMs);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

