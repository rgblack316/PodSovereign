/**
 * Clearing replaced files from Cloudflare's cache. Made files keep their exact names (ru053.mp3), so a new
 * version is stored at the same address; without clearing, Cloudflare could keep serving the old copy.
 * Needs the zone ID and an API token with the "Zone → Cache Purge" permission (Site settings → Cloudflare).
 */
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';

export class CdnError extends Error {
  constructor(message: string, readonly status = 424) {
    super(message);
  }
}

interface CfEnvelope<T> { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T }

async function cf<T>(config: Config, method: string, apiPath: string, token: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(config.cloudflareApiUrl.replace(/\/+$/, '') + apiPath, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new CdnError(`Couldn’t reach Cloudflare: ${(e as Error).message}`);
  }
  let env: CfEnvelope<T> | null = null;
  try {
    env = (await res.json()) as CfEnvelope<T>;
  } catch {
    /* not JSON */
  }
  if (!res.ok || !env?.success) {
    const msg = env?.errors?.map((e) => e.message).filter(Boolean).join('; ') || `status ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new CdnError(`Cloudflare didn’t accept the API token (${msg}). It needs the Zone → Cache Purge permission for this domain.`);
    throw new CdnError(`Cloudflare answered: ${msg}`);
  }
  return env.result as T;
}

/** Check a zone ID and token; returns the zone's domain name. */
export async function testCloudflare(config: Config, zoneId: string, token: string): Promise<string> {
  if (!/^[0-9a-f]{32}$/i.test(zoneId)) throw new CdnError('Enter the zone ID (32 letters and numbers, on the domain’s Overview page)', 400);
  const z = await cf<{ name?: string }>(config, 'GET', `/zones/${zoneId}`, token);
  return z?.name ?? 'the zone';
}

/** Every address a media path is served from (the media address, and the site's own if different). */
export function mediaUrls(config: Config, publicPaths: string[]): string[] {
  const bases = new Set([config.mediaBaseUrl, config.publicBaseUrl].map((b) => b.replace(/\/+$/, '')));
  return publicPaths.flatMap((p) => [...bases].map((b) => b + p));
}

/**
 * Clear these media files from Cloudflare's cache. Never throws: the result is logged and shown
 * in Site settings. Returns false when clearing isn't set up or failed.
 */
export async function purgeMedia(db: Db, config: Config, publicPaths: string[], log?: (m: string) => void): Promise<boolean> {
  if (!publicPaths.length) return true;
  if (!config.cfZoneId || !config.cfApiToken) {
    log?.(`cdn: ${publicPaths.join(', ')} replaced; set up Cloudflare cache clearing in Site settings so the old copy isn't served`);
    return false;
  }
  const urls = mediaUrls(config, publicPaths);
  try {
    for (let i = 0; i < urls.length; i += 30) { // Cloudflare takes up to 30 addresses per request
      await cf(config, 'POST', `/zones/${config.cfZoneId}/purge_cache`, config.cfApiToken, { files: urls.slice(i, i + 30) });
    }
    await db.query(`UPDATE site_settings SET cf_purge_at = now(), cf_purge_error = NULL WHERE id`);
    log?.(`cdn: cleared ${urls.length} addresses from Cloudflare's cache`);
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    await db.query(`UPDATE site_settings SET cf_purge_at = now(), cf_purge_error = $1 WHERE id`, [msg.slice(0, 1000)]).catch(() => {});
    log?.(`cdn: clearing Cloudflare's cache failed: ${msg}`);
    return false;
  }
}
