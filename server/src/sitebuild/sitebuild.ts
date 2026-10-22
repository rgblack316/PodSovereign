/**
 * Website rebuilds: when a show's feed changes (new episode, edit, removal,
 * a scheduled episode going live), call the show's build hook so its website
 * (Cloudflare Pages, Netlify, Vercel, Render, GitHub Actions or any webhook)
 * rebuilds from the updated feed.
 *
 * This runs alongside Podping but doesn't depend on it: it fires on the feed
 * change itself, even when Podping is off or fails. Changes wait 45 seconds
 * after the last one, so a burst of edits makes one build. Failed calls are
 * retried (3 attempts in all). Hook URLs, tokens and header values are
 * secrets: stored encrypted, never sent back to the browser or logged.
 */
import { seal, unseal } from '../crypto/secrets.js';
import { maybeOne, type Db, type Queryable } from '../db/db.js';

export class SiteBuildError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const BUILD_EVENTS = ['published', 'edited', 'deleted', 'scheduled', 'show'] as const;
export type BuildEvent = (typeof BUILD_EVENTS)[number];
const DEFAULT_EVENTS: BuildEvent[] = ['published', 'edited', 'deleted', 'scheduled'];

/** Wait this long after the last change before calling the hook. */
export const buildTiming = { debounceSec: 45, timeoutMs: 30_000 };
/** GitHub's API address (tests point it at a fake). */
export const buildEndpoints = { github: 'https://api.github.com' };
const MAX_ATTEMPTS = 3;
const HISTORY_KEEP = 10;

interface FieldDef {
  key: string;
  label: string;
  type: 'url' | 'text' | 'secret' | 'select' | 'headers' | 'json';
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: string[];
  default?: string;
}

interface ServiceDef {
  id: string;
  name: string;
  /** Where to find the values, shown above the fields. */
  help: string;
  docsUrl?: string;
  fields: FieldDef[];
}

const hookField = (label: string, placeholder: string): FieldDef => ({ key: 'url', label, type: 'url', secret: true, required: true, placeholder });

export const BUILD_SERVICES: ServiceDef[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare Pages',
    help: 'In Cloudflare: your Pages project → Settings → Builds → Deploy hooks → Add deploy hook (choose the branch) → copy the URL.',
    docsUrl: 'https://developers.cloudflare.com/pages/configuration/deploy-hooks/',
    fields: [hookField('Deploy hook URL', 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/…')],
  },
  {
    id: 'netlify',
    name: 'Netlify',
    help: 'In Netlify: Site configuration → Build & deploy → Build hooks → Add build hook → copy the URL.',
    docsUrl: 'https://docs.netlify.com/configure-builds/build-hooks/',
    fields: [hookField('Build hook URL', 'https://api.netlify.com/build_hooks/…')],
  },
  {
    id: 'vercel',
    name: 'Vercel',
    help: 'In Vercel: Project → Settings → Git → Deploy Hooks → create a hook (choose the branch) → copy the URL.',
    docsUrl: 'https://vercel.com/docs/deployments/deploy-hooks',
    fields: [hookField('Deploy hook URL', 'https://api.vercel.com/v1/integrations/deploy/…')],
  },
  {
    id: 'render',
    name: 'Render',
    help: 'In Render: your service → Settings → Deploy Hook → copy the URL.',
    docsUrl: 'https://render.com/docs/deploy-hooks',
    fields: [hookField('Deploy hook URL', 'https://api.render.com/deploy/srv-…')],
  },
  {
    id: 'github',
    name: 'GitHub Actions',
    help: 'Create a fine-grained personal access token for just this repository with Contents: Read and write. The repository’s workflow must start on the event: on: repository_dispatch: types: [rebuild]',
    docsUrl: 'https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event',
    fields: [
      { key: 'owner', label: 'Repository owner', type: 'text', required: true, placeholder: 'rgblack316' },
      { key: 'repo', label: 'Repository name', type: 'text', required: true, placeholder: 'my-podcast-website' },
      { key: 'token', label: 'Access token', type: 'secret', secret: true, required: true, placeholder: 'github_pat_…' },
      { key: 'eventType', label: 'Event type', type: 'text', default: 'rebuild', hint: 'Must match types: in the workflow.' },
    ],
  },
  {
    id: 'custom',
    name: 'Custom webhook',
    help: 'Any address that starts a build when called, such as a small endpoint on your own server that runs the site’s build script.',
    fields: [
      { key: 'url', label: 'URL', type: 'url', secret: true, required: true, placeholder: 'https://build.example.com/hooks/rebuild' },
      { key: 'method', label: 'Method', type: 'select', options: ['POST', 'GET'], default: 'POST' },
      { key: 'headers', label: 'Headers', type: 'headers', hint: 'For example Authorization. Values are stored encrypted.' },
      { key: 'body', label: 'JSON body (optional)', type: 'json', placeholder: '{"site": "wvedtalk"}' },
    ],
  },
];

const serviceById = (id: string) => BUILD_SERVICES.find((s) => s.id === id);

interface Secrets { url?: string; token?: string; headers?: Record<string, string> }
interface Settings { owner?: string; repo?: string; eventType?: string; method?: 'POST' | 'GET'; headerNames?: string[]; body?: string }
interface HookRow { podcast_id: string; enabled: boolean; service: string; settings: Settings; secrets: string | null; events: string[] }

const readSecrets = (row: HookRow | null): Secrets => {
  if (!row?.secrets) return {};
  try {
    return JSON.parse(unseal(row.secrets, 'a website build hook') ?? '{}') as Secrets;
  } catch {
    return {};
  }
};

const getHook = (q: Queryable, podcastId: string) => maybeOne<HookRow>(q, `SELECT * FROM site_build_hooks WHERE podcast_id = $1`, [podcastId]);

// ───────────── settings ─────────────

export async function buildView(q: Queryable, podcastId: string) {
  const row = await getHook(q, podcastId);
  const sec = readSecrets(row);
  const { rows: history } = await q.query(
    `SELECT events, trigger, status, attempts, last_status AS "lastStatus", last_error AS "lastError",
            created_at AS "createdAt", sent_at AS "sentAt", next_try_at AS "nextTryAt"
       FROM site_build_queue WHERE podcast_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [podcastId, HISTORY_KEEP],
  );
  return {
    enabled: row?.enabled ?? false,
    service: row?.service ?? 'cloudflare',
    settings: { ...(row?.settings ?? {}) },
    saved: { url: !!sec.url, token: !!sec.token, headers: Object.keys(sec.headers ?? {}) },
    events: row?.events ?? DEFAULT_EVENTS,
    history,
    services: BUILD_SERVICES,
    eventNames: BUILD_EVENTS,
  };
}

export interface BuildInput {
  enabled?: unknown;
  service?: unknown;
  /** Field values by key; secret fields left blank keep the saved value (same service only). */
  fields?: Record<string, unknown>;
  events?: unknown;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function httpUrl(v: string, label: string, httpsOnly: boolean): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new SiteBuildError(`${label}: enter the full address, starting with https://`);
  }
  if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) throw new SiteBuildError(`${label} must start with https://`);
  if (u.username || u.password) throw new SiteBuildError(`${label} can’t include a login; use a header instead`);
  return u.toString();
}

/** Validate the form into settings + secrets (blank secrets keep the saved ones when the service is unchanged). */
function parseFields(service: ServiceDef, fields: Record<string, unknown>, saved: { service: string; settings: Settings; secrets: Secrets }): { settings: Settings; secrets: Secrets } {
  const same = saved.service === service.id;
  const old = same ? saved.secrets : {};
  const settings: Settings = {};
  const secrets: Secrets = {};
  for (const f of service.fields) {
    const v = fields[f.key];
    if (f.key === 'url') {
      const url = str(v);
      secrets.url = url ? httpUrl(url, f.label, service.id !== 'custom') : old.url;
      if (!secrets.url) throw new SiteBuildError(`${f.label} is required`);
    } else if (f.key === 'token') {
      secrets.token = str(v) || old.token;
      if (!secrets.token) throw new SiteBuildError(`${f.label} is required`);
      if (/\s/.test(secrets.token)) throw new SiteBuildError(`${f.label} can’t contain spaces`);
    } else if (f.key === 'owner' || f.key === 'repo') {
      const s = str(v) || (same ? saved.settings[f.key] ?? '' : '');
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(s)) throw new SiteBuildError(`${f.label}: letters, numbers, dashes, dots and underscores`);
      settings[f.key] = s;
    } else if (f.key === 'eventType') {
      const s = str(v) || 'rebuild';
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(s)) throw new SiteBuildError(`${f.label}: letters, numbers, dashes, dots and underscores`);
      settings.eventType = s;
    } else if (f.key === 'method') {
      const m = str(v).toUpperCase() || 'POST';
      if (m !== 'POST' && m !== 'GET') throw new SiteBuildError('Method must be POST or GET');
      settings.method = m;
    } else if (f.key === 'headers') {
      const list = Array.isArray(v) ? v : [];
      if (list.length > 20) throw new SiteBuildError('At most 20 headers');
      const headers: Record<string, string> = {};
      for (const h of list as { name?: unknown; value?: unknown }[]) {
        const name = str(h?.name);
        if (!name) continue;
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name)) throw new SiteBuildError(`“${name}” isn’t a valid header name`);
        if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) throw new SiteBuildError(`The ${name} header is set automatically`);
        const value = typeof h?.value === 'string' && h.value !== '' ? h.value : old.headers?.[name];
        if (value === undefined) throw new SiteBuildError(`Enter a value for the ${name} header`);
        if (/[\r\n]/.test(value)) throw new SiteBuildError(`The ${name} header can’t contain line breaks`);
        headers[name] = value;
      }
      settings.headerNames = Object.keys(headers);
      if (settings.headerNames.length) secrets.headers = headers;
    } else if (f.key === 'body') {
      const b = str(v);
      if (b) {
        try {
          JSON.parse(b);
        } catch {
          throw new SiteBuildError('The JSON body isn’t valid JSON');
        }
        if (b.length > 10_000) throw new SiteBuildError('The JSON body is too long');
        settings.body = b;
      }
    }
  }
  if (service.id === 'custom' && settings.method === 'GET' && settings.body) throw new SiteBuildError('A GET request can’t have a body; choose POST or remove the body');
  return { settings, secrets };
}

function parseEvents(v: unknown): BuildEvent[] {
  if (!Array.isArray(v)) throw new SiteBuildError('Choose which changes rebuild the website');
  const list = [...new Set(v)].filter((e): e is BuildEvent => (BUILD_EVENTS as readonly string[]).includes(e as string));
  if (list.length !== v.length) throw new SiteBuildError('Unknown change type');
  return list;
}

export async function saveBuildSettings(q: Queryable, podcastId: string, input: BuildInput): Promise<void> {
  const row = await getHook(q, podcastId);
  const current = { service: row?.service ?? 'cloudflare', settings: row?.settings ?? {}, secrets: readSecrets(row) };
  const enabled = input.enabled === undefined ? row?.enabled ?? false : input.enabled === true;
  const serviceId = input.service === undefined ? current.service : str(input.service);
  const service = serviceById(serviceId);
  if (!service) throw new SiteBuildError('Choose a build service');
  const events = input.events === undefined ? (row?.events as BuildEvent[] | undefined) ?? DEFAULT_EVENTS : parseEvents(input.events);

  let settings = current.settings;
  let secrets = current.secrets;
  if (input.fields !== undefined || serviceId !== current.service) {
    ({ settings, secrets } = parseFields(service, (input.fields ?? {}) as Record<string, unknown>, current));
  } else if (enabled && !row?.secrets) {
    throw new SiteBuildError('Fill in the build service details first');
  }
  await q.query(
    `INSERT INTO site_build_hooks (podcast_id, enabled, service, settings, secrets, events, updated_at)
     VALUES ($1, $2, $3, $4, $5, ARRAY(SELECT jsonb_array_elements_text($6::jsonb)), now())
     ON CONFLICT (podcast_id) DO UPDATE SET enabled = EXCLUDED.enabled, service = EXCLUDED.service, settings = EXCLUDED.settings,
            secrets = EXCLUDED.secrets, events = EXCLUDED.events, updated_at = now()`,
    [podcastId, enabled, service.id, JSON.stringify(settings), seal(JSON.stringify(secrets)), JSON.stringify(events)],
  );
  // Turned off: drop a build that was waiting.
  if (!enabled) await q.query(`DELETE FROM site_build_queue WHERE podcast_id = $1 AND status = 'pending'`, [podcastId]);
}

// ───────────── the request ─────────────

interface BuildRequest { method: 'POST' | 'GET'; url: string; headers: Record<string, string>; body?: string; okStatus?: number }

function buildRequest(service: string, settings: Settings, secrets: Secrets): BuildRequest {
  const ua = { 'User-Agent': 'PodSovereign (+website rebuild)' };
  switch (service) {
    case 'cloudflare':
    case 'netlify':
    case 'vercel':
    case 'render':
      if (!secrets.url) throw new SiteBuildError('The hook URL isn’t saved');
      return { method: 'POST', url: secrets.url, headers: ua, body: '' };
    case 'github':
      if (!secrets.token || !settings.owner || !settings.repo) throw new SiteBuildError('The repository and token aren’t saved');
      return {
        method: 'POST',
        url: `${buildEndpoints.github}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/dispatches`,
        headers: { ...ua, Authorization: `Bearer ${secrets.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: settings.eventType || 'rebuild' }),
      };
    case 'custom': {
      if (!secrets.url) throw new SiteBuildError('The URL isn’t saved');
      const method = settings.method ?? 'POST';
      const headers: Record<string, string> = { ...ua, ...(secrets.headers ?? {}) };
      if (method === 'POST' && settings.body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
      return { method, url: secrets.url, headers, body: method === 'POST' ? settings.body ?? '' : undefined };
    }
    default:
      throw new SiteBuildError('Unknown build service');
  }
}

/** Call the hook once. Never puts the URL, token or header values in the result. */
async function callHook(req: BuildRequest, fetchImpl: typeof fetch): Promise<{ ok: boolean; status: number | null; detail: string }> {
  try {
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(buildTiming.timeoutMs) });
    await res.arrayBuffer().catch(() => null);
    const ok = res.status >= 200 && res.status < 300;
    const hint = res.status === 401 || res.status === 403 ? ' (check the token or hook URL)' : res.status === 404 ? ' (check the hook URL, or the repository name and token access)' : '';
    return { ok, status: res.status, detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${hint}` };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === 'TimeoutError') return { ok: false, status: null, detail: `No answer within ${buildTiming.timeoutMs / 1000} seconds` };
    return { ok: false, status: null, detail: `Couldn’t connect${err.cause?.code ? ` (${err.cause.code})` : ''}` };
  }
}

// ───────────── queue ─────────────

/**
 * The feed changed: queue a build if this show rebuilds its website on this
 * kind of change. A build already waiting is pushed back 45 seconds and
 * collects the change, so several quick changes make one build.
 */
export async function queueBuild(q: Queryable, podcastId: string, event: BuildEvent): Promise<boolean> {
  const row = await maybeOne<{ enabled: boolean; events: string[]; status: string }>(
    q, `SELECT h.enabled, h.events, p.status FROM site_build_hooks h JOIN podcasts p ON p.id = h.podcast_id WHERE h.podcast_id = $1`, [podcastId],
  );
  if (!row?.enabled || row.status !== 'active' || !row.events.includes(event)) return false;
  await q.query(
    `INSERT INTO site_build_queue (podcast_id, events, trigger, next_try_at)
     VALUES ($1, ARRAY[$2]::text[], 'auto', now() + make_interval(secs => $3))
     ON CONFLICT (podcast_id) WHERE status = 'pending' DO UPDATE
       SET next_try_at = GREATEST(site_build_queue.next_try_at, EXCLUDED.next_try_at),
           events = ARRAY(SELECT DISTINCT unnest(site_build_queue.events || EXCLUDED.events))`,
    [podcastId, event, buildTiming.debounceSec],
  );
  return true;
}

/** Rebuild now (button): queued to go on the next worker pass. */
export async function queueManualBuild(q: Queryable, podcastId: string): Promise<void> {
  const row = await getHook(q, podcastId);
  if (!row?.secrets) throw new SiteBuildError('Save the build service details first');
  await q.query(
    `INSERT INTO site_build_queue (podcast_id, events, trigger, next_try_at) VALUES ($1, '{}', 'manual', now())
     ON CONFLICT (podcast_id) WHERE status = 'pending' DO UPDATE SET next_try_at = now(), trigger = 'manual'`,
    [podcastId],
  );
}

/**
 * Test: call the hook now with the form's values (or the saved ones), record it
 * in the history, and return the result.
 */
export async function testBuild(db: Db, podcastId: string, input: BuildInput | null, fetchImpl: typeof fetch = fetch) {
  const row = await getHook(db, podcastId);
  const current = { service: row?.service ?? 'cloudflare', settings: row?.settings ?? {}, secrets: readSecrets(row) };
  let req: BuildRequest;
  if (input && (input.fields !== undefined || input.service !== undefined)) {
    const service = serviceById(input.service === undefined ? current.service : str(input.service));
    if (!service) throw new SiteBuildError('Choose a build service');
    const { settings, secrets } = parseFields(service, (input.fields ?? {}) as Record<string, unknown>, current);
    req = buildRequest(service.id, settings, secrets);
  } else {
    if (!row?.secrets) throw new SiteBuildError('Fill in the build service details first');
    req = buildRequest(current.service, current.settings, current.secrets);
  }
  const r = await callHook(req, fetchImpl);
  await db.query(
    `INSERT INTO site_build_queue (podcast_id, trigger, status, attempts, last_status, last_error, sent_at)
     VALUES ($1, 'test', $2, 1, $3, $4, now())`,
    [podcastId, r.ok ? 'sent' : 'failed', r.status, r.ok ? null : r.detail],
  );
  await trimBuildHistory(db);
  return r;
}

/** Call every build that's due. Failures are retried after 30 seconds, then 2 minutes. */
export async function sendDueBuilds(db: Db, fetchImpl: typeof fetch = fetch): Promise<{ sent: number; failed: number }> {
  const { rows } = await db.query<{ id: string; podcast_id: string; attempts: number }>(
    `SELECT id, podcast_id, attempts FROM site_build_queue WHERE status = 'pending' AND next_try_at <= now() ORDER BY next_try_at LIMIT 20`,
  );
  let sent = 0;
  let failed = 0;
  for (const b of rows) {
    const hook = await getHook(db, b.podcast_id);
    let r: { ok: boolean; status: number | null; detail: string };
    if (!hook) r = { ok: false, status: null, detail: 'The build settings were removed' };
    else {
      try {
        r = await callHook(buildRequest(hook.service, hook.settings, readSecrets(hook)), fetchImpl);
      } catch (e) {
        r = { ok: false, status: null, detail: (e as Error).message };
      }
    }
    const attempts = b.attempts + 1;
    if (r.ok) {
      await db.query(`UPDATE site_build_queue SET status = 'sent', attempts = $2, last_status = $3, last_error = NULL, sent_at = now() WHERE id = $1`, [b.id, attempts, r.status]);
      sent++;
    } else {
      const giveUp = attempts >= MAX_ATTEMPTS || !hook;
      await db.query(
        `UPDATE site_build_queue SET attempts = $2, last_status = $3, last_error = $4,
                status = CASE WHEN $5 THEN 'failed' ELSE 'pending' END,
                sent_at = CASE WHEN $5 THEN now() ELSE sent_at END,
                next_try_at = now() + make_interval(secs => $6)
          WHERE id = $1`,
        [b.id, attempts, r.status, r.detail, giveUp, 30 * 4 ** (attempts - 1)],
      );
      failed++;
    }
  }
  await trimBuildHistory(db);
  return { sent, failed };
}

async function trimBuildHistory(q: Queryable) {
  await q.query(
    `DELETE FROM site_build_queue WHERE id IN (
       SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY podcast_id ORDER BY created_at DESC) AS n
                         FROM site_build_queue WHERE status <> 'pending') old WHERE n > $1)`,
    [HISTORY_KEEP],
  );
}
