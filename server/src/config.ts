import path from 'node:path';
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
  /** Podcast Index's open hub for Podping: GET <url>?url=<feed>&podping=1 */
  podpingHubUrl: string;
  /** Wait this long before sending, so a burst of edits becomes one ping. */
  podpingDelaySec: number;
  /** Name shown in the dashboard (Site settings). */
  siteName: string;
  /** Where the uploaded logo and favicon are stored. */
  siteDir: string;
  /** Bumped when branding changes, for cache-busting logo/favicon URLs. */
  siteVersion: number;
  /** Where media is stored: this server's disk, or a storage provider (Site settings → Media storage). */
  storage: { provider: string; settings: Record<string, string | boolean>; secret: string | null };
  /** While existing media is being moved to new storage: the store it is moving from. */
  storageMoveFrom: { provider: string; settings: Record<string, string | boolean>; secret: string | null } | null;
  /** Importers must prove they own a show before it's imported (Site settings). */
  requireVerification: boolean;
  /** Outgoing email for verification codes (SMTP or Resend); null = not set up. */
  mail: import('./mail/mailer.js').MailSettings | null;
  /** Resend API base URL (overridable for tests). */
  resendApiUrl: string;
  /** OP3 stats API token (Site settings), null = not set up. */
  op3Token: string | null;
  /** OP3 API base (overridable for tests). */
  op3ApiUrl: string;
  /** Key that encrypts saved secrets: SECRET_KEY, else this file (created on first start). */
  secretKeyFile: string;
  /** OpenStreetMap place search used by the Location lookup. */
  nominatimUrl: string;
  /** Hostnames this site used before a base-URL change; requests for them are 301-redirected. */
  previousHosts: string[];
  /**
   * Values from the environment. Site settings saved in the admin panel
   * override them; a blank setting falls back to these.
   */
  envDefaults: {
    publicBaseUrl: string;
    mediaBaseUrl: string | null;
    allowRegistration: boolean;
    cookieSecure: boolean | null;
  };
}

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const mediaBaseUrl = env.MEDIA_BASE_URL ? env.MEDIA_BASE_URL.replace(/\/+$/, '') : null;
  const cookieSecure = env.COOKIE_SECURE === undefined ? null : bool(env.COOKIE_SECURE, false);
  return {
    port: num(env.PORT, 8080),
    host: env.HOST ?? '127.0.0.1',
    databaseUrl: env.DATABASE_URL ?? 'postgres://feedhost@localhost/feedhost',
    publicBaseUrl,
    mediaBaseUrl: (env.MEDIA_BASE_URL ?? publicBaseUrl).replace(/\/+$/, ''),
    mediaDir: env.MEDIA_DIR ?? '/var/lib/podsovereign/media',
    cookieSecure: bool(env.COOKIE_SECURE, publicBaseUrl.startsWith('https://')),
    allowRegistration: bool(env.ALLOW_REGISTRATION, false),
    allowPrivateNetworks: bool(env.ALLOW_PRIVATE_NETWORKS, false),
    maxFeedBytes: num(env.MAX_FEED_BYTES, 25 * 1024 * 1024),
    maxMediaBytes: num(env.MAX_MEDIA_BYTES, 4 * 1024 * 1024 * 1024),
    downloadConcurrency: num(env.DOWNLOAD_CONCURRENCY, 3),
    sessionDays: num(env.SESSION_DAYS, 30),
    podpingHubUrl: env.PODPING_HUB_URL ?? 'https://hub.podcastindex.org/pubnotify',
    podpingDelaySec: num(env.PODPING_DELAY_SEC, 30),
    siteName: env.SITE_NAME?.trim() || 'PodSovereign',
    siteDir: env.SITE_DIR ?? '/var/lib/podsovereign/site',
    siteVersion: 0,
    storage: { provider: 'local', settings: {}, secret: null },
    storageMoveFrom: null,
    requireVerification: true,
    mail: null,
    resendApiUrl: env.RESEND_API_URL ?? 'https://api.resend.com',
    op3Token: null,
    op3ApiUrl: env.OP3_API_URL ?? 'https://op3.dev/api/1',
    secretKeyFile: env.SECRET_KEY_FILE ?? path.join(path.dirname(env.MEDIA_DIR ?? '/var/lib/podsovereign/media'), 'secret.key'),
    nominatimUrl: env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org/',
    previousHosts: [],
    envDefaults: {
      publicBaseUrl,
      mediaBaseUrl,
      allowRegistration: bool(env.ALLOW_REGISTRATION, false),
      cookieSecure,
    },
  };
}
