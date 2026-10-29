import { createHash, timingSafeEqual } from 'node:crypto';
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
import { cancelImport, checkCode, checkFeed, markVerified, sendCode, VERIFY_EXPIRES_DAYS, VerifyError, verifyingJob } from '../import/verify.js';
import { MailError, sendEmail } from '../mail/mailer.js';
import { createLiveItem, deleteLiveItem, listLiveItems, LiveError, setLiveStatus, updateLiveItem } from '../live/live.js';
import { latestPings, queuePing, setShowPodping } from '../podping/podping.js';
import { feedPath, mediaPrefix } from '../urls.js';
import { checkRedirect, saveRedirectResult } from './redirect-check.js';
import { addMember, deleteUser, listTeam, removeMember, setAdmin, setRole, TeamError } from '../db/team.js';
import { serveStatic } from './static.js';
import { CdnError, testCloudflare } from '../cdn/purge.js';
import { appendChunk, cancelUpload, completeUpload, getMedia, startUpload, UploadError, uploadStatus } from '../media/uploads.js';
import { isReferenced, ownMediaPaths, pruneMedia } from '../media/prune.js';
import { createEpisode, deleteEpisode, getEpisode, listEpisodes, updateEpisode } from '../publish/episodes.js';
import { PublishError } from '../publish/fields.js';
import { createShow, getShow, updateShow } from '../publish/show.js';
import { APPLE_CATEGORIES, MEDIUMS } from '../publish/categories.js';
import { lookupPlace } from '../publish/location.js';
import { lookupFeed } from '../publish/tag-fields.js';
import { BackupError, backupView, finishRun, runBackup, saveBackupSettings, startRun, testBucket } from '../backup/backups.js';
import { backupFileName, dumpStream, encryptStream, pgDumpVersion } from '../backup/dump.js';
import { changeStorage, latestMove, MoveError } from '../storage/move.js';
import { unseal } from '../crypto/secrets.js';
import { buildView, queueManualBuild, saveBuildSettings, SiteBuildError, testBuild } from '../sitebuild/sitebuild.js';
import { applyShownotes, handleWebhook, isRunning, latestJob, listPresets, processingView, saveShowSettings, setPublishIntent, showSettings, startProcessing, testAuphonicKey, AuphonicError } from '../auphonic/auphonic.js';
import { chaptersFromAudio, getChapters, isWritingMp3, saveChapters, startMp3ChapterWrite } from '../publish/chapters.js';
import { Op3Error, op3Daily, op3State, requestOp3Refresh, testOp3Token } from '../stats/op3.js';
import { PROVIDERS, StorageConfigError, validateSettings, type StorageSettings } from '../storage/providers.js';
import { localPath, storeFor, testConnection, type StorageState } from '../storage/store.js';
import {
  readSiteAsset,
  removeSiteAsset,
  saveSiteAsset,
  saveSiteSettings,
  SettingsError,
  siteSettingsView,
} from '../site/settings.js';
import { HttpError, parseCookies, readJson, Router, sendJson, type Ctx } from './router.js';

export const SESSION_COOKIE = 'fh_session';
const MAX_ACTIVE_IMPORTS = 3;
/** The Overview tab hides this many days after a show's setup steps are all done. */
const OVERVIEW_DAYS = 7;
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

  router.get('/api/admin/users', async (ctx) => {
    await requireAdmin(ctx);
    const { rows } = await db.query<User & { podcasts: number; shows: { id: string; title: string; role: string }[] | null }>(
      `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at,
              (SELECT count(*)::int FROM podcasts p WHERE p.owner_id = u.id) AS podcasts,
              (SELECT json_agg(json_build_object('id', s.id, 'title', s.title, 'role', s.role) ORDER BY s.role = 'owner' DESC, s.title)
                 FROM (SELECT p.id, p.title, 'owner' AS role FROM podcasts p WHERE p.owner_id = u.id
                       UNION ALL
                       SELECT p.id, p.title, m.role FROM podcast_members m JOIN podcasts p ON p.id = m.podcast_id WHERE m.user_id = u.id) s) AS shows
         FROM users u ORDER BY u.created_at`,
    );
    sendJson(ctx.res, 200, {
      users: rows.map((u) => ({ ...userJson(u), podcasts: u.podcasts, shows: u.shows ?? [], createdAt: u.created_at })),
    });
  });

  router.patch('/api/admin/users/:userId', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.req);
    await db.tx((q) => setAdmin(q, admin.id, ctx.params.userId!, body.isAdmin));
    sendJson(ctx.res, 204, undefined);
  });

  /** {shows: "transfer", transferTo: userId} or {shows: "delete"} when the account owns shows. */
  router.delete('/api/admin/users/:userId', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const target = ctx.params.userId!;
    const owned = isUuid(target) ? (await db.query<{ id: string }>(`SELECT id FROM podcasts WHERE owner_id = $1`, [target])).rows.map((r) => r.id) : [];
    const where = await remoteProviders(owned);
    const r = await db.tx((q) => deleteUser(q, config, admin.id, target, body));
    for (const show of r.deletedShows) await removeShowFiles(show.slug, where(show.id));
    sendJson(ctx.res, 200, { deletedShows: r.deletedShows.length, transferred: r.transferred });
  });

  /** Public: lets the sign-in page know whether to offer "create the first account". */
  router.get('/api/setup', async (ctx) => {
    const r = await maybeOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM users`);
    sendJson(ctx.res, 200, {
      needsFirstAccount: (r?.n ?? 0) === 0,
      registrationOpen: config.allowRegistration,
      publicBaseUrl: config.publicBaseUrl,
      siteName: config.siteName,
      siteVersion: config.siteVersion,
    });
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
        podpingEnabled: p.podping_enabled,
        redirectStatus: p.redirect_status,
        redirectConfirmed: !!p.redirect_confirmed_at,
        imported: p.imported,
        liveNow: p.live_now,
        mediaFailed: p.media_failed,
      })),
    });
  });

  router.get('/api/podcasts/:id', async (ctx) => {
    const { podcastId, role } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, { podcast: await podcastDetail(podcastId, role) });
  });

  async function podcastDetail(podcastId: string, role: Role) {
    const p = (await getPodcastRow(db, podcastId))! as Awaited<ReturnType<typeof getPodcastRow>> & Record<string, any>;
    const media = (await maybeOne<{ done: number; failed: number; pending: number; bytes: number }>(
      db,
      `SELECT count(*) FILTER (WHERE status = 'done')::int AS done,
              count(*) FILTER (WHERE status = 'failed')::int AS failed,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              COALESCE(sum(bytes) FILTER (WHERE status = 'done'), 0)::bigint AS bytes
         FROM media_files WHERE podcast_id = $1`,
      [podcastId],
    ))!;
    const counts = (await maybeOne<{ episodes: number; live_now: number; live_upcoming: number }>(
      db,
      `SELECT (SELECT count(*)::int FROM episodes WHERE podcast_id = $1) AS episodes,
              (SELECT count(*)::int FROM tag_elements WHERE podcast_id = $1 AND episode_id IS NULL
                 AND ns_prefix = 'podcast' AND name = 'liveItem' AND attributes->>'status' = 'live') AS live_now,
              (SELECT count(*)::int FROM tag_elements WHERE podcast_id = $1 AND episode_id IS NULL
                 AND ns_prefix = 'podcast' AND name = 'liveItem' AND attributes->>'status' = 'pending') AS live_upcoming`,
      [podcastId],
    ))!;
    // Setup is done when an imported show's media is copied, the old feed 301s here and Podping is on;
    // for a new show, when the directory checklist is empty. Overview hides 7 days after that.
    const setupDone = p.source_feed_url
      ? p.status === 'active' && !media.pending && p.redirect_status === 'ok' && p.podping_enabled
      : p.status === 'active' && (await getShow(db, podcastId)).checklist.length === 0;
    let completedAt: Date | null = p.setup_completed_at ?? null;
    if (setupDone && !completedAt) {
      completedAt = (await maybeOne<{ at: Date }>(db, `UPDATE podcasts SET setup_completed_at = now() WHERE id = $1 RETURNING setup_completed_at AS at`, [podcastId]))!.at;
    } else if (!setupDone && completedAt) {
      completedAt = null;
      await db.query(`UPDATE podcasts SET setup_completed_at = NULL WHERE id = $1`, [podcastId]);
    }
    const overviewHidesAt = completedAt ? new Date(new Date(completedAt).getTime() + OVERVIEW_DAYS * 86400_000) : null;
    return {
      id: p.id,
      slug: p.slug,
      status: p.status,
      role,
      feedUrl: feedUrl(p.slug),
      // Where episode files are served from: the CDN or storage provider's address when one is set.
      mediaUrl: config.mediaBaseUrl + mediaPrefix(p.slug),
      setup: {
        done: setupDone,
        completedAt,
        overviewHidesAt,
        overviewHidden: !!overviewHidesAt && overviewHidesAt.getTime() <= Date.now(),
      },
      sourceFeedUrl: p.source_feed_url,
      importedAt: p.imported_at,
      title: p.title,
      description: p.description,
      imageUrl: p.image_url,
      author: p.itunes_author,
      language: p.language,
      podcastGuid: p.podcast_guid,
      episodeCount: counts.episodes,
      media,
      podping: { enabled: p.podping_enabled },
      // Shows using the OP3 prefix get an OP3 Stats tab.
      op3: !!(await maybeOne(db, `SELECT 1 FROM podcast_prefixes WHERE podcast_id = $1 AND service_key = 'op3' AND enabled`, [podcastId])),
      live: { now: counts.live_now, upcoming: counts.live_upcoming },
      redirect: { status: p.redirect_status, detail: p.redirect_detail, checkedAt: p.redirect_checked_at, confirmedAt: p.redirect_confirmed_at },
    };
  }

  /** Check whether the old host now 301-redirects to this feed (the move's last step). */
  router.post('/api/podcasts/:id/redirect-check', async (ctx) => {
    const { podcastId, role } = await requirePodcast(ctx, 'editor');
    const p = (await getPodcastRow(db, podcastId))! as unknown as { slug: string; source_feed_url: string | null };
    if (!p.source_feed_url) throw new HttpError(400, 'This show was not imported, so there is no old feed to check');
    const result = await checkRedirect(config, p.source_feed_url, feedUrl(p.slug));
    await saveRedirectResult(db, podcastId, result);
    sendJson(ctx.res, 200, { result, podcast: await podcastDetail(podcastId, role) });
  });

  /** Remove a deleted show's copied media wherever it lives. */
  async function removeShowFiles(slug: string, providers: string[]) {
    if (!/^[a-z0-9-]+$/.test(slug)) return; // validated on creation; check again anyway
    const dir = path.resolve(config.mediaDir, slug);
    if (path.dirname(dir) === path.resolve(config.mediaDir)) await rm(dir, { recursive: true, force: true });
    for (const provider of providers) {
      try {
        await storeFor(config, provider).deletePrefix(`${slug}/`);
      } catch (e) {
        deps.log?.(`couldn't delete ${slug}/ from ${provider}: ${(e as Error).message}`);
      }
    }
  }
  const remoteProviders = async (podcastIds: string[]) => {
    const { rows } = await db.query<{ podcast_id: string; storage_provider: string }>(
      `SELECT DISTINCT podcast_id, storage_provider FROM media_files
        WHERE podcast_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid) AND storage_provider <> 'local'`,
      [JSON.stringify(podcastIds)],
    );
    return (id: string) => rows.filter((r) => r.podcast_id === id).map((r) => r.storage_provider);
  };

  router.delete('/api/podcasts/:id', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'owner');
    const p = (await getPodcastRow(db, podcastId))!;
    const where = await remoteProviders([podcastId]);
    await db.query(`DELETE FROM podcasts WHERE id = $1`, [podcastId]);
    await removeShowFiles(p.slug, where(podcastId));
    sendJson(ctx.res, 204, undefined);
  });

  // ───────────── team (who can work on a show) ─────────────

  router.get('/api/podcasts/:id/team', async (ctx) => {
    const { podcastId, user } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, { team: await listTeam(db, podcastId), me: user.id });
  });

  router.post('/api/podcasts/:id/team', async (ctx) => {
    const { podcastId, user } = await requirePodcast(ctx, 'owner');
    const body = await readJson(ctx.req);
    await db.tx((q) => addMember(q, podcastId, body.email, body.role));
    sendJson(ctx.res, 201, { team: await listTeam(db, podcastId), me: user.id });
  });

  /** {role: "editor" | "viewer" | "owner"}. "owner" hands the show over. */
  router.patch('/api/podcasts/:id/team/:userId', async (ctx) => {
    const { podcastId, user } = await requirePodcast(ctx, 'owner');
    const body = await readJson(ctx.req);
    await db.tx((q) => setRole(q, podcastId, ctx.params.userId!, body.role));
    sendJson(ctx.res, 200, { team: await listTeam(db, podcastId), me: user.id });
  });

  /** The owner removes someone, or a member leaves. */
  router.delete('/api/podcasts/:id/team/:userId', async (ctx) => {
    const { podcastId, user, role } = await requirePodcast(ctx, 'viewer');
    if (role !== 'owner' && ctx.params.userId !== user.id) throw new HttpError(403, 'Only the owner can remove people');
    await db.tx((q) => removeMember(q, podcastId, ctx.params.userId!));
    sendJson(ctx.res, 204, undefined);
  });

  // ───────────── publishing: new shows, show details, episodes ─────────────

  /** Start a show from scratch (the other way in is an import). */
  router.post('/api/podcasts', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.req);
    const id = await db.tx((q) => createShow(q, config, user.id, body));
    sendJson(ctx.res, 201, { podcast: await podcastDetail(id, 'owner') });
  });

  router.get('/api/categories', async (ctx) => {
    await requireUser(ctx);
    sendJson(ctx.res, 200, { categories: APPLE_CATEGORIES, mediums: MEDIUMS });
  });

  /** Look up a place on OpenStreetMap for the Location fields. */
  router.get('/api/places', async (ctx) => {
    await requireUser(ctx);
    sendJson(ctx.res, 200, { places: await lookupPlace(config, ctx.url.searchParams.get('q')) });
  });

  /** Look up another show by feed address (for recommended shows / podroll). */
  router.get('/api/feed-lookup', async (ctx) => {
    await requireUser(ctx);
    sendJson(ctx.res, 200, { show: await lookupFeed(config, ctx.url.searchParams.get('url')) });
  });

  router.get('/api/podcasts/:id/details', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, await getShow(db, podcastId));
  });

  router.put('/api/podcasts/:id/details', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req, 1024 * 1024);
    const { dropped } = await db.tx((q) => updateShow(q, config, podcastId, body));
    await pruneMedia(db, config, podcastId, dropped, deps.log);
    sendJson(ctx.res, 200, await getShow(db, podcastId));
  });

  router.get('/api/podcasts/:id/episodes', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, { episodes: await listEpisodes(db, podcastId) });
  });

  router.post('/api/podcasts/:id/episodes', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req, 1024 * 1024);
    const id = await db.tx((q) => createEpisode(q, config, podcastId, body));
    sendJson(ctx.res, 201, { episode: await getEpisode(db, podcastId, id), processing: null });
  });

  router.get('/api/podcasts/:id/episodes/:episodeId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, { episode: await getEpisode(db, podcastId, ctx.params.episodeId!), processing: await processingView(db, ctx.params.episodeId!) });
  });

  /** Only the fields sent are changed. */
  router.patch('/api/podcasts/:id/episodes/:episodeId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req, 1024 * 1024);
    const episodeId = ctx.params.episodeId!;
    // While Auphonic processes an episode that isn't public yet, Publish waits for it.
    const job = await latestJob(db, episodeId);
    if (isRunning(job)) {
      const cur = await getEpisode(db, podcastId, episodeId);
      if (!cur.inFeed && body.status === 'published') {
        await setPublishIntent(db, episodeId, { pubDate: typeof body.pubDate === 'string' ? body.pubDate : null });
        body.status = 'draft';
        delete body.pubDate;
      } else if (body.status === 'draft') await setPublishIntent(db, episodeId, null);
    }
    const { dropped } = await db.tx((q) => updateEpisode(q, config, podcastId, episodeId, body));
    await pruneMedia(db, config, podcastId, dropped, deps.log);
    sendJson(ctx.res, 200, { episode: await getEpisode(db, podcastId, episodeId), processing: await processingView(db, episodeId) });
  });

  // ───────────── Auphonic ─────────────

  router.get('/api/podcasts/:id/auphonic', async (ctx) => {
    const { podcastId, role } = await requirePodcast(ctx, 'viewer');
    const settings = await showSettings(db, podcastId);
    let presets: { uuid: string; name: string }[] = [];
    let error: string | null = null;
    if (config.auphonicKey && role !== 'viewer' && ctx.url.searchParams.get('presets') === '1') {
      try {
        presets = await listPresets(config);
      } catch (e) {
        error = (e as Error).message;
      }
    }
    sendJson(ctx.res, 200, { configured: !!config.auphonicKey, settings, presets, error });
  });

  router.put('/api/podcasts/:id/auphonic', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    await saveShowSettings(db, config, podcastId, await readJson(ctx.req));
    sendJson(ctx.res, 200, { configured: !!config.auphonicKey, settings: await showSettings(db, podcastId) });
  });

  /** Send the episode's audio to Auphonic (after it's saved, with its chapters), or reprocess the kept original. */
  router.post('/api/podcasts/:id/episodes/:episodeId/process', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req);
    const episodeId = ctx.params.episodeId!;
    const publish = body.publish && typeof body.publish === 'object' ? body.publish as { pubDate?: unknown } : null;
    await startProcessing(db, config, podcastId, episodeId, {
      reprocess: body.reprocess === true,
      mediaId: typeof body.mediaId === 'string' ? body.mediaId : undefined,
      publishIntent: publish ? { pubDate: typeof publish.pubDate === 'string' ? publish.pubDate : null } : null,
      ai: { chapters: body.chapters, shownotes: body.shownotes },
      log: deps.log,
    });
    sendJson(ctx.res, 200, { processing: await processingView(db, episodeId) });
  });

  /** Use the show notes Auphonic wrote as the episode's description. */
  router.post('/api/podcasts/:id/episodes/:episodeId/process/use-shownotes', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    await applyShownotes(db, config, podcastId, ctx.params.episodeId!);
    sendJson(ctx.res, 200, { processing: await processingView(db, ctx.params.episodeId!) });
  });

  router.get('/api/podcasts/:id/episodes/:episodeId/process', async (ctx) => {
    await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, { processing: await processingView(db, ctx.params.episodeId!) });
  });

  router.post('/api/admin/site/test-auphonic', async (ctx) => {
    await requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : config.auphonicKey;
    if (!key) throw new HttpError(400, 'Enter the Auphonic API key first');
    sendJson(ctx.res, 200, { ok: true, account: await testAuphonicKey(config, key) });
  });

  /** Check a Cloudflare zone ID and API token (the form's values, else the saved ones). */
  router.post('/api/admin/site/test-cloudflare', async (ctx) => {
    await requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const zoneId = typeof body.zoneId === 'string' && body.zoneId.trim() ? body.zoneId.trim() : config.cfZoneId;
    const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : config.cfApiToken;
    if (!zoneId || !token) throw new HttpError(400, 'Enter the zone ID and API token first');
    const zone = await testCloudflare(config, zoneId, token);
    const mediaHost = new URL(config.mediaBaseUrl).hostname;
    const covers = mediaHost === zone || mediaHost.endsWith(`.${zone}`);
    sendJson(ctx.res, 200, { ok: true, zone, mediaHost, coversMedia: covers });
  });

  /** Auphonic's callback when a production finishes (outside /api: no cookies, a secret in the address). */
  router.post('/hooks/auphonic/:token', async (ctx) => {
    const expected = config.auphonicHookToken ?? '';
    const got = ctx.params.token ?? '';
    if (!expected || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) throw new HttpError(404, 'Not found');
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of ctx.req) {
      n += (c as Buffer).length;
      if (n > 64 * 1024) throw new HttpError(413, 'Too large');
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let uuid: string | null = null;
    try {
      uuid = (JSON.parse(raw) as { uuid?: string }).uuid ?? null;
    } catch {
      uuid = new URLSearchParams(raw).get('uuid');
    }
    if (uuid) await handleWebhook(db, config, uuid, deps.log);
    sendJson(ctx.res, 200, { ok: true });
  });

  // ───────────── chapters ─────────────

  router.get('/api/podcasts/:id/episodes/:episodeId/chapters', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    const r = await getChapters(db, config, podcastId, ctx.params.episodeId!);
    sendJson(ctx.res, 200, { ...r, writing: isWritingMp3(ctx.params.episodeId!) });
  });

  router.put('/api/podcasts/:id/episodes/:episodeId/chapters', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req, 1024 * 1024);
    const episodeId = ctx.params.episodeId!;
    const dropped = await saveChapters(db, config, podcastId, episodeId, body.chapters);
    await pruneMedia(db, config, podcastId, dropped, deps.log);
    if (body.writeToMp3 === true) startMp3ChapterWrite(db, config, podcastId, episodeId, deps.log);
    const r = await getChapters(db, config, podcastId, episodeId);
    sendJson(ctx.res, 200, { ...r, writing: isWritingMp3(episodeId) });
  });

  router.post('/api/podcasts/:id/episodes/:episodeId/chapters/write-mp3', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    startMp3ChapterWrite(db, config, podcastId, ctx.params.episodeId!, deps.log);
    const r = await getChapters(db, config, podcastId, ctx.params.episodeId!);
    sendJson(ctx.res, 200, { ...r, writing: true });
  });

  router.post('/api/podcasts/:id/media/:mediaId/id3-chapters', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    sendJson(ctx.res, 200, { chapters: await chaptersFromAudio(db, config, podcastId, ctx.params.mediaId!) });
  });

  router.delete('/api/podcasts/:id/episodes/:episodeId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const { dropped } = await db.tx((q) => deleteEpisode(q, config, podcastId, ctx.params.episodeId!));
    await pruneMedia(db, config, podcastId, dropped, deps.log);
    sendJson(ctx.res, 204, undefined);
  });

  // ───────────── uploads ─────────────

  router.post('/api/podcasts/:id/uploads', async (ctx) => {
    const { podcastId, user } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 201, { upload: await startUpload(db, config, podcastId, user.id, body) });
  });

  /** How much has arrived, to resume an interrupted upload. */
  router.get('/api/podcasts/:id/uploads/:uploadId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    sendJson(ctx.res, 200, { upload: await uploadStatus(db, podcastId, ctx.params.uploadId!) });
  });

  /** One chunk of raw bytes, sent as application/octet-stream, at ?offset= */
  router.put('/api/podcasts/:id/uploads/:uploadId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const offset = Number(ctx.url.searchParams.get('offset') ?? 'NaN');
    sendJson(ctx.res, 200, await appendChunk(db, config, podcastId, ctx.params.uploadId!, offset, ctx.req));
  });

  router.post('/api/podcasts/:id/uploads/:uploadId/complete', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    sendJson(ctx.res, 201, { media: await completeUpload(db, config, podcastId, ctx.params.uploadId!) });
  });

  router.delete('/api/podcasts/:id/uploads/:uploadId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    await cancelUpload(db, config, podcastId, ctx.params.uploadId!);
    sendJson(ctx.res, 204, undefined);
  });

  /** Remove an uploaded file that isn't used anywhere (an upload the editor didn't save). */
  router.delete('/api/podcasts/:id/media/:mediaId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const m = await getMedia(db, config, podcastId, ctx.params.mediaId);
    if (!m) throw new HttpError(404, 'File not found');
    const [publicPath] = ownMediaPaths((await getPodcastRow(db, podcastId))!.slug, [m.url]);
    if (!publicPath) throw new HttpError(404, 'File not found');
    if (await isReferenced(db, podcastId, publicPath)) throw new HttpError(409, 'That file is in use');
    await pruneMedia(db, config, podcastId, [publicPath], deps.log);
    sendJson(ctx.res, 204, undefined);
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

  // ───────────── website rebuilds ─────────────

  router.get('/api/podcasts/:id/site-build', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, await buildView(db, podcastId));
  });

  router.put('/api/podcasts/:id/site-build', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req, 64 * 1024);
    await db.tx((q) => saveBuildSettings(q, podcastId, body));
    sendJson(ctx.res, 200, await buildView(db, podcastId));
  });

  router.post('/api/podcasts/:id/site-build/test', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req, 64 * 1024);
    const result = await testBuild(db, podcastId, body && Object.keys(body).length ? body : null);
    sendJson(ctx.res, 200, { result, ...(await buildView(db, podcastId)) });
  });

  router.post('/api/podcasts/:id/site-build/run', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    await queueManualBuild(db, podcastId);
    sendJson(ctx.res, 200, await buildView(db, podcastId));
  });

  // ───────────── live items (<podcast:liveItem>) ─────────────

  router.get('/api/podcasts/:id/live', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, { liveItems: await listLiveItems(db, podcastId) });
  });

  router.post('/api/podcasts/:id/live', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req);
    const item = await db.tx((q) => createLiveItem(q, podcastId, body));
    sendJson(ctx.res, 201, { liveItem: item });
  });

  router.patch('/api/podcasts/:id/live/:liveId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req);
    const item = await db.tx((q) => updateLiveItem(q, podcastId, ctx.params.liveId!, body));
    sendJson(ctx.res, 200, { liveItem: item });
  });

  /** Body: {"status": "pending" | "live" | "ended"} */
  router.post('/api/podcasts/:id/live/:liveId/status', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    const body = await readJson(ctx.req);
    const item = await db.tx((q) => setLiveStatus(q, config, podcastId, ctx.params.liveId!, body.status));
    sendJson(ctx.res, 200, { liveItem: item });
  });

  router.delete('/api/podcasts/:id/live/:liveId', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'editor');
    await db.tx((q) => deleteLiveItem(q, config, podcastId, ctx.params.liveId!));
    sendJson(ctx.res, 204, undefined);
  });

  // ───────────── imports ─────────────

  router.post('/api/imports', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.req);
    const active = await maybeOne<{ n: number }>(
      db,
      `SELECT count(*)::int AS n FROM import_jobs WHERE user_id = $1 AND status IN ('queued','running','verifying')`,
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
    const j = await maybeOne<Record<string, any>>(
      db,
      `SELECT id, podcast_id AS "podcastId", source_url AS "sourceUrl", status, progress, warnings, error,
              created_at AS "createdAt", finished_at AS "finishedAt", preview, verify_token, verify_email,
              verify_code_expires, verified_method AS "verifiedMethod"
         FROM import_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId],
    );
    if (!j) return null;
    const { verify_token, verify_email, verify_code_expires, ...rest } = j;
    return {
      ...rest,
      verification: j.status === 'verifying'
        ? {
            token: verify_token,
            tag: `<podcast:txt purpose="verify">${verify_token}</podcast:txt>`,
            canEmail: !!config.mail && !!verify_email,
            emailReason: !config.mail ? 'not_configured' : !verify_email ? 'no_owner_email' : null,
            codeSent: !!verify_code_expires && new Date(verify_code_expires).getTime() > Date.now(),
            expiresInDays: VERIFY_EXPIRES_DAYS,
          }
        : null,
    };
  }

  // ───────────── ownership verification ─────────────

  router.post('/api/imports/:id/check-feed', async (ctx) => {
    const user = await requireUser(ctx);
    const r = await checkFeed(db, config, ctx.params.id!, user.id);
    sendJson(ctx.res, 200, { ...r, job: await jobJson(user.id, ctx.params.id!) });
  });

  router.post('/api/imports/:id/send-code', async (ctx) => {
    const user = await requireUser(ctx);
    let r;
    try {
      r = await sendCode(db, config, ctx.params.id!, user.id);
    } catch (e) {
      if (e instanceof MailError) throw new VerifyError(`The code couldn’t be sent: ${e.message}. Use the feed tag instead, or ask an admin to check the email settings.`, 502);
      throw e;
    }
    sendJson(ctx.res, 200, { ...r, job: await jobJson(user.id, ctx.params.id!) });
  });

  router.post('/api/imports/:id/verify-code', async (ctx) => {
    const user = await requireUser(ctx);
    const body = await readJson(ctx.req);
    await checkCode(db, ctx.params.id!, user.id, body.code);
    sendJson(ctx.res, 200, { verified: true, job: await jobJson(user.id, ctx.params.id!) });
  });

  /** Admins may vouch for shows they manage. */
  router.post('/api/imports/:id/skip-verification', async (ctx) => {
    const user = await requireAdmin(ctx);
    await verifyingJob(db, ctx.params.id!, user.id);
    await markVerified(db, ctx.params.id!, 'admin');
    sendJson(ctx.res, 200, { verified: true, job: await jobJson(user.id, ctx.params.id!) });
  });

  router.post('/api/imports/:id/cancel', async (ctx) => {
    const user = await requireUser(ctx);
    await cancelImport(db, ctx.params.id!, user.id);
    sendJson(ctx.res, 200, { job: await jobJson(user.id, ctx.params.id!) });
  });

  // Storage used: every stored file (episodes, artwork, transcripts, chapters), by account and show.
  // A show counts toward its owner's account.
  router.get('/api/admin/storage-usage', async (ctx) => {
    await requireAdmin(ctx);
    const { rows: shows } = await db.query<{ id: string; title: string; slug: string; owner_id: string; files: number; bytes: string }>(
      `SELECT p.id, p.title, p.slug, p.owner_id,
              count(m.id) FILTER (WHERE m.status = 'done')::int AS files,
              COALESCE(sum(m.bytes) FILTER (WHERE m.status = 'done'), 0)::bigint AS bytes
         FROM podcasts p LEFT JOIN media_files m ON m.podcast_id = p.id
        GROUP BY p.id ORDER BY bytes DESC, p.title`,
    );
    const { rows: users } = await db.query<{ id: string; email: string; display_name: string | null; is_admin: boolean }>(
      `SELECT id, email, display_name, is_admin FROM users ORDER BY created_at`,
    );
    const showList = shows.map((s) => ({ id: s.id, title: s.title, slug: s.slug, ownerId: s.owner_id, files: s.files, bytes: Number(s.bytes) }));
    const accounts = users.map((u) => {
      const mine = showList.filter((s) => s.ownerId === u.id);
      return {
        id: u.id, email: u.email, name: u.display_name, isAdmin: u.is_admin,
        shows: mine.length, files: mine.reduce((a, s) => a + s.files, 0), bytes: mine.reduce((a, s) => a + s.bytes, 0),
      };
    }).sort((a, b) => b.bytes - a.bytes || a.email.localeCompare(b.email));
    sendJson(ctx.res, 200, {
      total: { bytes: showList.reduce((a, s) => a + s.bytes, 0), files: showList.reduce((a, s) => a + s.files, 0), shows: showList.length, accounts: users.length },
      accounts,
      shows: showList,
    });
  });

  router.post('/api/admin/site/test-op3', async (ctx) => {
    await requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : config.op3Token;
    if (!token) throw new HttpError(400, 'Enter the OP3 API token first');
    await testOp3Token(config, token);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.get('/api/podcasts/:id/op3', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    sendJson(ctx.res, 200, await op3State(db, config, podcastId, { log: deps.log }));
  });

  router.post('/api/podcasts/:id/op3/refresh', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    const started = await requestOp3Refresh(db, config, podcastId, { log: deps.log });
    sendJson(ctx.res, 200, { started, ...(await op3State(db, config, podcastId)) });
  });

  router.get('/api/podcasts/:id/op3/daily', async (ctx) => {
    const { podcastId } = await requirePodcast(ctx, 'viewer');
    const days = Number(ctx.url.searchParams.get('days') ?? 30);
    if (![7, 30, 90, 365].includes(days)) throw new HttpError(400, 'days must be 7, 30, 90 or 365');
    sendJson(ctx.res, 200, await op3Daily(db, config, podcastId, days));
  });

  router.post('/api/admin/site/test-email', async (ctx) => {
    const user = await requireAdmin(ctx);
    if (!config.mail) throw new HttpError(400, 'Save the email settings first');
    const body = await readJson(ctx.req);
    const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : user.email;
    try {
      await sendEmail(config, {
        to,
        subject: `Test email from ${config.siteName}`,
        text: `This is a test from ${config.siteName} (${config.publicBaseUrl}).\n\nIf you got it, email is set up: podcasters can now confirm they own a show with an emailed code.`,
      });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    }
    sendJson(ctx.res, 200, { sentTo: to });
  });

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
        usesPodping: (p as unknown as { podping_enabled: boolean }).podping_enabled,
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
    const key = `${slug}/media/${kind}/${file}`;
    const row = await maybeOne<{ mime_type: string | null; storage_provider: string }>(
      db,
      `SELECT mime_type, storage_provider FROM media_files WHERE storage_key = $1 AND status = 'done'`,
      [key],
    );
    // Moved to a storage provider: send apps holding an older feed copy to the file's new home.
    if (row && row.storage_provider !== 'local') {
      ctx.res.writeHead(301, { Location: `${config.mediaBaseUrl}/${key}`, 'Cache-Control': 'public, max-age=86400' });
      ctx.res.end();
      return;
    }
    const full = localPath(config.mediaDir, key);
    const st = row && (await stat(full).catch(() => null));
    if (!row || !st?.isFile()) throw new HttpError(404, 'Not found');
    sendFile(ctx.req, ctx.res, full, st.size, row.mime_type ?? 'application/octet-stream');
  });

  // ───────────── site settings (admin) ─────────────

  async function requireAdmin(ctx: Ctx) {
    const user = await requireUser(ctx);
    if (!user.is_admin) throw new HttpError(403, 'Admins only');
    return user;
  }

  router.get('/api/admin/site', async (ctx) => {
    await requireAdmin(ctx);
    sendJson(ctx.res, 200, { settings: await siteSettingsView(db, config) });
  });

  router.put('/api/admin/site', async (ctx) => {
    await requireAdmin(ctx);
    const body = await readJson(ctx.req);
    const result = await saveSiteSettings(db, config, body);
    sendJson(ctx.res, 200, { result, settings: await siteSettingsView(db, config) });
  });

  for (const kind of ['logo', 'favicon'] as const) {
    router.post(`/api/admin/site/${kind}`, async (ctx) => {
      await requireAdmin(ctx);
      const body = await readJson(ctx.req, 2 * 1024 * 1024);
      await saveSiteAsset(db, config, kind, body.dataUrl);
      sendJson(ctx.res, 200, { settings: await siteSettingsView(db, config), siteVersion: config.siteVersion });
    });
    router.delete(`/api/admin/site/${kind}`, async (ctx) => {
      await requireAdmin(ctx);
      await removeSiteAsset(db, config, kind);
      sendJson(ctx.res, 200, { settings: await siteSettingsView(db, config), siteVersion: config.siteVersion });
    });
    /** Public: the uploaded image, or the built-in icon. */
    router.get(`/site/${kind}`, async (ctx) => {
      const asset = await readSiteAsset(db, config, kind);
      if (!asset) return serveStatic(ctx, 'icon.svg');
      ctx.res.writeHead(200, {
        'Content-Type': asset.type,
        'Cache-Control': 'public, max-age=300',
        // An uploaded SVG opened directly can't run scripts or load anything.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      });
      ctx.res.end(ctx.req.method === 'HEAD' ? undefined : asset.body);
    });
  }

  // ───────────── backups (admin) ─────────────

  const backupState = async () => ({ ...(await backupView(db, config)), pgDump: await pgDumpVersion() });

  router.get('/api/admin/backups', async (ctx) => {
    await requireAdmin(ctx);
    sendJson(ctx.res, 200, await backupState());
  });

  router.put('/api/admin/backups', async (ctx) => {
    await requireAdmin(ctx);
    await saveBackupSettings(db, await readJson(ctx.req));
    sendJson(ctx.res, 200, await backupState());
  });

  router.post('/api/admin/backups/test-bucket', async (ctx) => {
    await requireAdmin(ctx);
    const body = (await readJson(ctx.req).catch(() => ({}))) as { storage?: unknown };
    sendJson(ctx.res, 200, await testBucket(db, body?.storage));
  });

  /** Back up now and send it wherever automatic backups go. */
  router.post('/api/admin/backups/run', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const run = await runBackup(db, config, 'manual', admin.id);
    sendJson(ctx.res, 200, { run, ...(await backupState()) });
  });

  /** Stream a fresh backup to the browser. ?encrypt=1 encrypts it with the backup passphrase. */
  router.get('/api/admin/backups/download', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const passphrase = ctx.url.searchParams.get('encrypt') === '1'
      ? unseal((await maybeOne<{ p: string | null }>(db, `SELECT backup_passphrase AS p FROM site_settings WHERE id`))?.p ?? null, 'the backup passphrase')
      : null;
    if (ctx.url.searchParams.get('encrypt') === '1' && !passphrase) throw new HttpError(400, 'Set a backup passphrase first');
    const fileName = backupFileName(new Date(), !!passphrase);
    const runId = await startRun(db, 'download', admin.id, fileName, !!passphrase);
    let source: NodeJS.ReadableStream = dumpStream(config.databaseUrl);
    if (passphrase) source = (source as import('node:stream').Readable).pipe(encryptStream(passphrase));
    let bytes = 0;
    try {
      for await (const chunk of source) {
        // Headers wait for the first bytes, so a failure to start is a clear error, not a broken file.
        if (!ctx.res.headersSent) {
          ctx.res.writeHead(200, {
            'Content-Type': passphrase ? 'application/octet-stream' : 'application/gzip',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Cache-Control': 'no-store',
          });
        }
        bytes += (chunk as Buffer).length;
        if (!ctx.res.write(chunk)) await new Promise((r) => ctx.res.once('drain', r));
      }
      ctx.res.end();
      await finishRun(db, runId, { status: 'done', bytes, results: [{ to: 'download', ok: true, detail: `Downloaded by ${admin.email}` }] });
    } catch (e) {
      await finishRun(db, runId, { status: 'failed', bytes, error: (e as Error).message });
      if (ctx.res.headersSent) return void ctx.res.destroy();
      throw new HttpError(500, (e as Error).message);
    }
  });

  // ───────────── media storage (admin) ─────────────

  /** Form input → storage state; a blank secret keeps the saved one when the provider is unchanged. */
  function storageInput(body: Record<string, unknown>): StorageState {
    const provider = String(body.provider ?? '');
    if (provider === 'local') return { provider: 'local', settings: {}, secret: null };
    const settings = (body.settings && typeof body.settings === 'object' ? body.settings : {}) as StorageSettings;
    let secret = typeof body.secret === 'string' && body.secret.trim() ? body.secret.trim() : null;
    if (!secret && config.storage.provider === provider) secret = config.storage.secret;
    return { provider, settings: validateSettings(provider, settings, secret), secret };
  }

  async function storageView() {
    const s = config.storage;
    const counts = (await maybeOne<{ files: number; bytes: number; local: number }>(
      db,
      `SELECT count(*)::int AS files, COALESCE(sum(bytes), 0)::bigint AS bytes,
              count(*) FILTER (WHERE storage_provider = 'local')::int AS local
         FROM media_files WHERE status = 'done' AND storage_key IS NOT NULL`,
    ))!;
    const move = await latestMove(db);
    return {
      providers: PROVIDERS,
      current: { provider: s.provider, settings: s.settings, secretSet: !!s.secret, publicBase: config.mediaBaseUrl },
      media: counts,
      move: move && {
        id: move.id,
        status: move.status,
        to: move.to_state.provider,
        total: move.total,
        moved: move.moved,
        failed: move.failed,
        bytes: move.bytes,
        error: move.error,
        createdAt: move.created_at,
        finishedAt: move.finished_at,
      },
    };
  }

  router.get('/api/admin/storage', async (ctx) => {
    await requireAdmin(ctx);
    sendJson(ctx.res, 200, await storageView());
  });

  /** Try the settings without saving: upload, read back, download publicly, delete. */
  router.post('/api/admin/storage/test', async (ctx) => {
    await requireAdmin(ctx);
    const state = storageInput(await readJson(ctx.req));
    if (state.provider === 'local') {
      return sendJson(ctx.res, 200, { ok: true, steps: [{ step: 'This server', ok: true, detail: 'Files are stored on this server’s disk.' }] });
    }
    sendJson(ctx.res, 200, await testConnection(config, state));
  });

  router.put('/api/admin/storage', async (ctx) => {
    const admin = await requireAdmin(ctx);
    const state = storageInput(await readJson(ctx.req));
    if (state.provider !== 'local') {
      const test = await testConnection(config, state);
      if (!test.ok) return sendJson(ctx.res, 400, { error: 'The connection test failed, so nothing was changed.', test });
    }
    const result = await changeStorage(db, config, state, admin.id);
    sendJson(ctx.res, result.move ? 202 : 200, { ...result, storage: await storageView() });
  });

  // ───────────── dashboard (static) ─────────────

  router.get('/', async (ctx) => serveStatic(ctx, 'index.html'));
  router.get('/app/:file', async (ctx) => serveStatic(ctx, ctx.params.file!));

  router.get('/healthz', async (ctx) => {
    await db.query('SELECT 1');
    sendJson(ctx.res, 200, { ok: true, version: process.env.FEEDHOST_VERSION ?? 'dev' });
  });

  // ───────────── request handling ─────────────

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      const method = req.method ?? 'GET';
      // After a site-address change, anything still arriving on an old hostname (feeds, media,
      // the dashboard) is permanently redirected, so apps that reach us there follow along.
      const reqHost = (req.headers.host ?? '').toLowerCase();
      if (reqHost && config.previousHosts.includes(reqHost) && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(301, { Location: config.publicBaseUrl + url.pathname + url.search, 'Cache-Control': 'public, max-age=3600' });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('X-Frame-Options', 'DENY');
        if (!['GET', 'HEAD'].includes(method)) checkCsrf(req, new URL(config.publicBaseUrl).origin, method === 'PUT' && UPLOAD_CHUNK.test(url.pathname));
      }
      const m = router.match(method, url.pathname);
      if (m === null) throw new HttpError(404, 'Not found');
      if (m === 'method') throw new HttpError(405, 'Method not allowed');
      await m.handler({ req, res, url, params: m.params });
    } catch (e) {
      // An outside service (Auphonic, OP3, email, a feed) failing is reported as 424, never 502/503/504:
      // Cloudflare replaces those with its own HTML error page, which hides the message from the dashboard.
      const fail = (status: number, body: unknown, headers?: Record<string, string>) =>
        sendJson(res, status >= 502 && status <= 504 ? 424 : status, body, headers);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof HttpError) return fail(e.status, { error: e.message }, e.headers);
      if (e instanceof AuthError || e instanceof LiveError || e instanceof VerifyError || e instanceof PublishError || e instanceof TeamError || e instanceof BackupError) return fail(e.status, { error: e.message });
      if (e instanceof AuphonicError) {
        deps.log?.(`auphonic: ${req.method} ${url.pathname}: ${e.message}`);
        return fail(e.status, { error: e.message });
      }
      if (e instanceof SiteBuildError) return fail(e.status, { error: e.message });
      if (e instanceof CdnError) return fail(e.status, { error: e.message });
      if (e instanceof Op3Error) return fail(e.status, { error: e.message, code: e.code ?? null });
      if (e instanceof UploadError) return fail(e.status, { error: e.message, ...e.extra });
      if (e instanceof ImportError || e instanceof PrefixError || e instanceof SettingsError || e instanceof StorageConfigError || e instanceof MoveError) {
        return fail(400, { error: e.message });
      }
      deps.log?.(`500 ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      sendJson(res, 500, { error: 'Something went wrong' });
    }
  };
}

/**
 * CSRF defence for cookie-authenticated API calls: state-changing requests
 * must be JSON (cross-site forms can't send that without a CORS preflight,
 * which we never approve; upload chunks use application/octet-stream, which
 * needs one too) and, when the browser says where they came from,
 * must come from our own origin.
 */
const UPLOAD_CHUNK = /^\/api\/podcasts\/[^/]+\/uploads\/[^/]+$/;

function checkCsrf(req: IncomingMessage, publicOrigin: string, isChunk = false) {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  // Upload chunks are raw bytes. Like JSON, application/octet-stream can't be sent cross-site without a preflight.
  if (isChunk ? type !== 'application/octet-stream' : type !== 'application/json') {
    throw new HttpError(415, isChunk ? 'Send upload chunks as application/octet-stream' : 'Send requests as application/json');
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request blocked');
  const origin = req.headers.origin;
  if (origin && origin !== publicOrigin && !isLocalOrigin(origin)) throw new HttpError(403, 'Cross-site request blocked');
}

/**
 * The dashboard opened on this machine (or through an SSH port-forward) before
 * the public address works. Only this machine can serve a localhost page, so
 * trusting it doesn't open the door to other sites.
 */
function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
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
