import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/db.js';
import { feedPath } from '../urls.js';
import { traceRedirects } from '../import/http.js';

export type RedirectStatus = 'ok' | 'temporary' | 'elsewhere' | 'none' | 'unreachable';

export interface RedirectResult {
  status: RedirectStatus;
  detail: string;
  hops: { url: string; status: number }[];
}

const strip = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

/**
 * Does the old feed URL permanently redirect to our feed? Apple and most apps
 * only move subscribers for a permanent (301/308) redirect.
 */
export async function checkRedirect(config: Config, oldUrl: string, newUrl: string): Promise<RedirectResult> {
  let hops;
  try {
    hops = await traceRedirects(
      oldUrl,
      { allowPrivate: config.allowPrivateNetworks, maxBytes: 1, timeoutMs: 15_000 },
      (u) => strip(u) === strip(newUrl),
    );
  } catch (e) {
    return { status: 'unreachable', detail: `Couldn't reach the old feed: ${(e as Error).message}`, hops: [] };
  }
  const first = hops[0]!;
  const last = hops[hops.length - 1]!;
  const landsHere = strip(last.url) === strip(newUrl);
  if (hops.length === 1) {
    return first.status >= 200 && first.status < 300
      ? { status: 'none', detail: 'The old feed still answers directly; no redirect yet.', hops }
      : { status: 'unreachable', detail: `The old feed answered HTTP ${first.status} with no redirect.`, hops };
  }
  if (!landsHere) {
    return { status: 'elsewhere', detail: `The old feed redirects to ${last.url}, not to this feed.`, hops };
  }
  if (first.status === 301 || first.status === 308) {
    return { status: 'ok', detail: 'The old feed permanently redirects here.', hops };
  }
  return {
    status: 'temporary',
    detail: `The old feed redirects here with HTTP ${first.status}. Ask the old host for a permanent (301) redirect so apps move subscribers.`,
    hops,
  };
}

export async function saveRedirectResult(q: Queryable, podcastId: string, r: RedirectResult) {
  await q.query(
    `UPDATE podcasts SET redirect_status = $2, redirect_detail = $3, redirect_checked_at = now(),
            redirect_confirmed_at = CASE WHEN $2 = 'ok' THEN COALESCE(redirect_confirmed_at, now()) ELSE redirect_confirmed_at END
      WHERE id = $1`,
    [podcastId, r.status, r.detail],
  );
}

/** Re-check confirmed redirects weekly; one that stopped working is re-checked daily until it's fixed. */
export const REDIRECT_RECHECK = { okDays: 7, brokenDays: 1 };

export async function recheckDueRedirects(db: Db, config: Config, log?: (m: string) => void, limit = 10): Promise<number> {
  const { rows } = await db.query<{ id: string; slug: string; source_feed_url: string; redirect_status: string | null }>(
    `SELECT id, slug, source_feed_url, redirect_status FROM podcasts
      WHERE status = 'active' AND source_feed_url IS NOT NULL AND redirect_confirmed_at IS NOT NULL
        AND (redirect_checked_at IS NULL
             OR redirect_checked_at < now() - make_interval(days => CASE WHEN redirect_status = 'ok' THEN $1::int ELSE $2::int END))
      ORDER BY redirect_checked_at NULLS FIRST LIMIT $3`,
    [REDIRECT_RECHECK.okDays, REDIRECT_RECHECK.brokenDays, limit],
  );
  for (const p of rows) {
    const r = await checkRedirect(config, p.source_feed_url, config.publicBaseUrl + feedPath(p.slug));
    await saveRedirectResult(db, p.id, r);
    if (r.status !== p.redirect_status) log?.(`redirect check for ${p.slug}: ${p.redirect_status ?? 'unchecked'} → ${r.status}`);
  }
  return rows.length;
}

export function startRedirectWorker(deps: { db: Db; config: Config; log?: (m: string) => void }, everyMs = 60 * 60_000) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    recheckDueRedirects(deps.db, deps.config, deps.log)
      .catch((e) => deps.log?.(`redirect checks: ${(e as Error).message}`))
      .finally(() => (running = false));
  };
  const first = setTimeout(tick, 5 * 60_000);
  const timer = setInterval(tick, everyMs);
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
