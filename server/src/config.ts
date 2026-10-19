export interface Config {
  port: number;
  /** Interface to listen on. 127.0.0.1 = reachable only through the tunnel / local proxy. */
  host: string;
  databaseUrl: string;
  /** Public origin of this server, e.g. https://feeds.example.com (no trailing slash). */
  publicBaseUrl: string;
  /**
   * Origin used in media URLs. Defaults to PUBLIC_BASE_URL; set it to a CDN
   * origin later to serve media from there instead of through the tunnel.
   */
  mediaBaseUrl: string;
  /** Where copied media is stored on disk (MEDIA_DIR/<slug>/<type>/<file>). */
  mediaDir: string;
  /** Set Secure on session cookies (true behind HTTPS). */
  cookieSecure: boolean;
  /** Anyone may sign up. When false, only the very first account (the admin) can self-register. */
  allowRegistration: boolean;
  /** Allow imports/downloads from private or local addresses (tests/dev only). */
  allowPrivateNetworks: boolean;
  maxFeedBytes: number;
  maxMediaBytes: number;
  downloadConcurrency: number;
  sessionDays: number;
  /** podping.cloud authorization token from Podcast Index. Unset = Podping off. */
  podpingToken: string | null;
  podpingUrl: string;
  /** Wait this long before sending, so a burst of edits becomes one ping. */
  podpingDelaySec: number;
}

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  return {
    port: num(env.PORT, 8080),
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? 'postgres://feedhost@localhost/feedhost',
    publicBaseUrl,
    mediaBaseUrl: (env.MEDIA_BASE_URL ?? publicBaseUrl).replace(/\/+$/, ''),
    mediaDir: env.MEDIA_DIR ?? '/var/lib/feedhost/media',
    cookieSecure: bool(env.COOKIE_SECURE, publicBaseUrl.startsWith('https://')),
    allowRegistration: bool(env.ALLOW_REGISTRATION, false),
    allowPrivateNetworks: bool(env.ALLOW_PRIVATE_NETWORKS, false),
    maxFeedBytes: num(env.MAX_FEED_BYTES, 25 * 1024 * 1024),
    maxMediaBytes: num(env.MAX_MEDIA_BYTES, 4 * 1024 * 1024 * 1024),
    downloadConcurrency: num(env.DOWNLOAD_CONCURRENCY, 3),
    sessionDays: num(env.SESSION_DAYS, 30),
    podpingToken: env.PODPING_TOKEN?.trim() || null,
    podpingUrl: env.PODPING_URL ?? 'https://podping.cloud/',
    podpingDelaySec: num(env.PODPING_DELAY_SEC, 30),
  };
}
