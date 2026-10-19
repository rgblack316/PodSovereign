import type { Config } from '../config.js';
import type { Queryable } from '../db/db.js';
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
    `UPDATE podcasts SET redirect_status = $2, redirect_detail = $3, redirect_checked_at = now() WHERE id = $1`,
    [podcastId, r.status, r.detail],
  );
}
