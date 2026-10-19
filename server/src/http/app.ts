import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { AuthError, authenticate, changePassword, createSession, createUserAsAdmin, deleteSession, normalizeEmail, registerUser, sessionUser, type User } from '../auth/users.js';
import { RateLimiter } from '../auth/rate-limit.js';
import type { Config } from '../config.js';
import { maybeOne, type Db } from '../db/db.js';
import {
  getPodcastBySlug,
  getPodcastRow,
  getPrefixConfig,
  isUuid,
  listPodcastsForUser,
  loadFeed,
  podcastRole,
  setPrefixConfig,
  type Role,
} from '../db/podcasts.js';
import { buildFeed } from '../feed/builder.js';
import { buildPrefixChain, PREFIX_SERVICES, PrefixError, type PrefixSetting } from '../feed/prefixes.js';
import { isPrivateAddress } from '../import/http.js';
import { enqueueImport, ImportError, KIND_DIRS } from '../import/importer.js';
import { latestPings, podpingEnabled, queuePing, setShowPodping } from '../podping/podping.js';
import { feedPath } from '../urls.js';
import { HttpError, parseCookies, readJson, Router, sendJson, type Ctx } from './router.js';

export const SESSION_COOKIE = 'fh_session';
const MAX_ACTIVE_IMPORTS = 3;
const KIND_DIR_NAMES = new Set(Object.values(KIND_DIRS));

export interface AppDeps {
  db: Db;
  config: Config;
  log?: (msg: string) => void;
}

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const router = new Router();
  const publicOrigin = new URL(config.publicBaseUrl).origin;

  // ───────────── helpers ─────────────

  const sessions = new WeakMap<IncomingMessage, { user: User; sessionId: string } | null>();
  async function current(ctx: Ctx) {
    if (!sessions.has(ctx.req)) {
      const token = parseCookies(ctx.req.headers.cookie)[SESSION_COOKIE];
      sessions.set(ctx.req, token ? await sessionUser(db, token) : null);
    }
    return sessions.get(ctx.req)!;
  }

  async function requireUser(ctx: Ctx): Promise<User> {
    const s = await current(ctx);
    if (!s) throw new HttpError(401, 'Please sign in');
    return s.user;
  }

  /** Every podcast route goes through here. No access and "doesn't exist" both give 404. */
  async function requirePodcast(ctx: Ctx, min: Role): Promise<{ user: User; podcastId: string; role: Role }> {
    const user = await requireUser(ctx);
    const podcastId = ctx.params.id!;
    const role = await podcastRole(db, user.id, podcastId);
    if (!role) throw new HttpError(404, 'Podcast not found');
    if (ROLE_RANK[role] < ROLE_RANK[min]) throw new HttpError(403, `This needs ${min} access`);
    return { user, podcastId, role };
  }

  function sessionCookie(token: string, maxAgeSec: number) {
    return [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`,
      config.cookieSecure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  /**
   * The visitor's real address. Behind Cloudflare Tunnel every request arrives
   * from cloudflared on this machine, so CF-Connecting-IP (or X-Real-IP from
   * Nginx) is used — but only when the hop is local/private, so a client
   * connecting directly can't spoof it.
   */
  const clientIp = (req: IncomingMessage) => {
    const peer = req.socket.remoteAddress ?? 'unknown';
    if (!isPrivateAddress(peer)) return peer;
    for (const h of ['cf-connecting-ip', 'x-real-ip']) {
      const v = req.headers[h];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return peer;
  };

  const userJson = (u: User) => ({ id: u.id, email: u.email, displayName: u.display_name, isAdmin: u.is_admin });
  const feedUrl = (slug: string) => config.publicBaseUrl + feedPath(slug);

  // ───────────── auth ─────────────

  router.post('/api/auth/register', async (ctx) => {
    const body = await readJson(ctx.req);
    const user = await registerUser(db, config, {
      email: body.email,
      password: body.password,
      displayName: body.displayName,
    });
    const token = await createSession(db, user.id, config.sessionDays, ctx.req.headers['user-agent']);
    sendJson(ctx.res, 201, { user: userJson(user) }, { 'Set-Cookie': sessionCookie(token, config.sessionDays * 86400) });
  });

  router.post('/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const keys = [`ip:${clientIp(ctx.req)}`, `email:${email}`];
    const wait = Math.max(...keys.map((k) => loginLimiter.retryAfter(k)));
    if (wait) throw new HttpError(429, 'Too many sign-in attempts. Try again later.', { 'Retry-After': String(wait) });

    const user = await authenticate(db, email, password);
    if (!user) {
      keys.forEach((k) => loginLimiter.fail(k));
      throw new HttpError(401, 'Email or password is incorrect');
    }
    loginLimiter.reset(`email:${email}`);
    const token = await createSession(db, user.id, config.sessionDays, ctx.req.headers['user-agent']);
    sendJson(ctx.res, 200, { user: userJson(user) }, { 'Set-Cookie': sessionCookie(token, config.sessionDays * 86400) });
  });

  router.post('/api/auth/logout', async (ctx) => {
    const s = await current(ctx);
    if (s) await deleteSession(db, s.sessionId);
    sendJson(ctx.res, 204, undefined, { 'Set-Cookie': sessionCookie('', 0) });
  });

  router.get('/api/me', async (ctx) => {
    sendJson(ctx.res, 200, { user: userJson(await requireUser(ctx)) });
  });

  router.post('/api/me/password', async (ctx) => {
    const s = await current(ctx);
    if (!s) throw new HttpError(401, 'Please sign in');
    const body = await readJson(ctx.req);
    await changePassword(db, s.user.id, String(body.currentPassword ?? ''), String(body.newPassword ?? ''), s.sessionId);
    sendJson(ctx.res, 204, undefined);
  });

  router.post('/api/admin/users', async (ctx) => {
    const user = await requireUser(ctx);
    if (!user.is_admin) throw new HttpError(403, 'Admins only');
    const body = await readJson(ctx.req);
    const created = await createUserAsAdmin(db, {
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      isAdmin: body.isAdmin,
    });
    sendJson(ctx.res, 201, { user: userJson(created) });
  });

  // ───────────── podcasts ─────────────

  router.get('/api/podcasts', async (ctx) => {
    const user = await requireUser(ctx);
    const list = await listPodcastsForUser(db, user.id);
    sendJson(ctx.res, 200, {
      podcasts: list.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        imageUrl: p.image_url,
        status: p.status,
        role: p.role,
        episodeCount: p.episode_count,
        feedUrl: feedUrl(p.slug),
      })),
    });
  });

  router.get('/api/podcasts/:id', async (ctx) => {
    const { podcastId, role } = await requirePodcast(ctx, 'viewer');
    const p = (await getPodcastRow(db, podcastId))!;
    sendJson(ctx.res, 200, {
      podcast: {
        id: p.id,
        slug: p.slug,
        status: p.status,
        role,
        feedUrl: feedUrl(p.slug),
        sourceFeedUrl: (p as unknown as { source_feed_url: string | null }).source_feed_url,
        title: p.title,
        description: p.description,
        imageUrl: p.image_url,
        author: p.itunes_author,
        language: p.language,
        podcastGuid: p.podcast_guid,
      },
    });
  });

  router.delete('/api/podcasts/:id', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'owner');
    const p = (await getPodcastRow(db, podcastId))!;
    await db.query(`DELETE FROM podcasts WHERE id = $1`, [podcastId]);
    // Remove copied media. The slug is validated on creation, but double-check the path stays inside mediaDir.
    const dir = path.resolve(config.mediaDir, p.slug);
    if (path.dirname(dir) === path.resolve(config.mediaDir) && /^[a-z0-9-]+$/.test(p.slug)) {
      await rm(dir, { recursive: true, force: true });
    }
    sendJson(ctx.res, 204, undefined);
  });

  router.get('/api/podcasts/:id/episodes', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT id, guid, title, status, pub_date, enclosure_url, enclosure_length, enclosure_type,
              itunes_duration, itunes_episode, itunes_season, itunes_episode_type
         FROM episodes WHERE podcast_id = $1 ORDER BY pub_date DESC NULLS LAST, sort_index`,
      [podcastId],
    );
    sendJson(ctx.res, 200, { episodes: rows });
  });

  // ───────────── stats prefixes ─────────────

  router.get('/api/prefix-services', async (ctx) => {
    await requireUser(ctx);
    sendJson(ctx.res, 200, { services: PREFIX_SERVICES });
  });

  router.get('/api/podcasts/:id/prefixes', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    const cfg = await getPrefixConfig(db, podcastId);
    sendJson(ctx.res, 200, { services: PREFIX_SERVICES, ...cfg });
  });

  router.put('/api/podcasts/:id/prefixes', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req);
    if (!Array.isArray(body.settings)) throw new HttpError(400, 'settings must be a list');
    const settings: PrefixSetting[] = body.settings.slice(0, 20).map((s: unknown, i: number) => {
      const o = (s ?? {}) as Record<string, unknown>;
      return {
        serviceKey: String(o.serviceKey ?? ''),
        enabled: o.enabled === true,
        paramValue: typeof o.paramValue === 'string' ? o.paramValue : null,
        position: Number.isInteger(o.position) ? (o.position as number) : i,
      };
    });
    await db.tx(async (q) => {
      await setPrefixConfig(q, podcastId, { settings, prefixAlternateEnclosures: body.prefixAlternateEnclosures === true });
      // Every enclosure URL just changed, so tell apps to refresh.
      await queuePing(q, config, podcastId, 'update');
    });
    const cfg = await getPrefixConfig(db, podcastId);
    sendJson(ctx.res, 200, { services: PREFIX_SERVICES, ...cfg, chain: buildPrefixChain(cfg.settings) });
  });

  // ───────────── podping ─────────────

  async function podpingStatus(podcastId: string) {
    const p = (await getPodcastRow(db, podcastId)) as unknown as { podping_enabled: boolean };
    return {
      serverEnabled: podpingEnabled(config),
      enabled: p.podping_enabled,
      pings: await latestPings(db, podcastId),
    };
  }

  router.get('/api/podcasts/:id/podping', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, await podpingStatus(podcastId));
  });

  /** The show's Podping switch. Turn it on after media is moved and the old host 301-redirects here. */
  router.put('/api/podcasts/:id/podping', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    await db.tx((q) => setShowPodping(q, config, podcastId, body.enabled as boolean));
    sendJson(ctx.res, 200, await podpingStatus(podcastId));
  });

  // ───────────── imports ─────────────

  router.post('/api/imports', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.req);
    const active = await maybeOne<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM import_jobs WHERE user_id = $1 AND status IN ('queued','running')`,
      [user.id],
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_IMPORTS) throw new HttpError(429, 'You already have imports in progress. Wait for one to finish.');
    const slug = typeof body.slug === 'string' && body.slug ? body.slug : undefined;
    const { id } = await enqueueImport(db, user.id, String(body.url ?? ''), { slug });
    sendJson(ctx.res, 202, { job: await jobJson(user.id, id) });
  });

  router.get('/api/imports', async (ctx) => {
    const user = await requireUser(ctx);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM import_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [user.id],
    );
    sendJson(ctx.res, 200, { jobs: await Promise.all(rows.map((r) => jobJson(user.id, r.id))) });
  });

  router.get('/api/imports/:id', async (ctx) => {
    const user = await requireUser(ctx);
    const job = isUuid(ctx.params.id!) ? await jobJson(user.id, ctx.params.id!) : null;
    if (!job) throw new HttpError(404, 'Import not found');
    sendJson(ctx.res, 200, { job });
  });

  async function jobJson(userId: string, jobId: string) {
    return maybeOne(
      db,
      `SELECT id, podcast_id AS "podcastId", source_url AS "sourceUrl", status, progress, warnings, error,
              created_at AS "createdAt", finished_at AS "finishedAt"
         FROM import_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId],
    );
  }

  // ───────────── public feed + media ─────────────

  router.get('/:slug/feed.xml', async (ctx) => {
    const p = await getPodcastBySlug(db, ctx.params.slug!);
    if (!p || p.status !== 'active') throw new HttpError(404, 'Feed not found');

    let xml = p.feed_cache_xml;
    let etag = p.feed_cache_etag;
    if (!xml || !etag) {
      const feed = (await loadFeed(db, p.id))!;
      const prefixCfg = await getPrefixConfig(db, p.id);
      let chain: string[] = [];
      try {
        chain = buildPrefixChain(prefixCfg.settings);
      } catch (e) {
        deps.log?.(`feed ${p.slug}: ignoring invalid prefix settings (${(e as Error).message})`);
      }
      xml = buildFeed(feed, {
        selfUrl: feedUrl(p.slug),
        prefixChain: chain,
        prefixAlternateEnclosures: prefixCfg.prefixAlternateEnclosures,
        usesPodping: podpingEnabled(config) && (p as unknown as { podping_enabled: boolean }).podping_enabled,
      });
      etag = `"${createHash('sha256').update(xml).digest('base64url').slice(0, 27)}"`;
      // Scheduled episodes appear on time because the cache is only kept until the next one is due.
      const nextDue = await maybeOne<{ due: Date | null }>(
        db,
        `SELECT min(pub_date) AS due FROM episodes WHERE podcast_id = $1 AND status IN ('published','scheduled') AND pub_date > now()`,
        [p.id],
      );
      if (!nextDue?.due) {
        await db.query(`UPDATE podcasts SET feed_cache_xml = $2, feed_cache_etag = $3 WHERE id = $1`, [p.id, xml, etag]);
      }
    }

    const headers = {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      ETag: etag,
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers).end();
      return;
    }
    ctx.res.writeHead(200, headers);
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : xml);
  });

  /** Serves copied media (byte ranges supported). A CDN can sit in front later via MEDIA_BASE_URL. */
  router.get('/:slug/media/:kind/:file', async (ctx) => {
    const { slug, kind, file } = ctx.params as { slug: string; kind: string; file: string };
    if (!/^[a-z0-9-]+$/.test(slug) || !KIND_DIR_NAMES.has(kind) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) {
      throw new HttpError(404, 'Not found');
    }
    const full = path.join(config.mediaDir, slug, kind, file);
    const row = await maybeOne<{ mime_type: string | null }>(
      db,
      `SELECT mime_type FROM media_files WHERE storage_path = $1 AND status = 'done'`,
      [full],
    );
    const st = row && (await stat(full).catch(() => null));
    if (!row || !st?.isFile()) throw new HttpError(404, 'Not found');
    sendFile(ctx.req, ctx.res, full, st.size, row.mime_type ?? 'application/octet-stream');
  });

  router.get('/healthz', async (ctx) => {
    await db.query('SELECT 1');
    sendJson(ctx.res, 200, { ok: true });
  });

  // ───────────── request handling ─────────────

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      const method = req.method ?? 'GET';
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('X-Frame-Options', 'DENY');
        if (!['GET', 'HEAD'].includes(method)) checkCsrf(req, publicOrigin);
      }
      const m = router.match(method, url.pathname);
      if (m === null) throw new HttpError(404, 'Not found');
      if (m === 'method') throw new HttpError(405, 'Method not allowed');
      await m.handler({ req, res, url, params: m.params });
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message }, e.headers);
      if (e instanceof AuthError) return sendJson(res, e.status, { error: e.message });
      if (e instanceof ImportError || e instanceof PrefixError) return sendJson(res, 400, { error: e.message });
      deps.log?.(`500 ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      sendJson(res, 500, { error: 'Something went wrong' });
    }
  };
}

/**
 * CSRF defence for cookie-authenticated API calls: state-changing requests
 * must be JSON (cross-site forms can't send that without a CORS preflight,
 * which we never approve) and, when the browser says where they came from,
 * must come from our own origin.
 */
function checkCsrf(req: IncomingMessage, publicOrigin: string) {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Send requests as application/json');
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request blocked');
  const origin = req.headers.origin;
  if (origin && origin !== publicOrigin) throw new HttpError(403, 'Cross-site request blocked');
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, size: number, type: string) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, 'Content-Length': size });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}
