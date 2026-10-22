import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { announceDueEpisodes } from '../src/podping/podping.js';
import { buildEndpoints, buildTiming, queueBuild, sendDueBuilds } from '../src/sitebuild/sitebuild.js';
import { setupDb, tempDir, testConfig } from './support/env.js';

let db: Db;
let server: http.Server;
let hooks: http.Server;
let base: string;
let hookBase: string;
let show: string;
const got: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let answer = 200;

class Client {
  cookie = '';
  async req(method: string, p: string, body?: unknown) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  }
  get = (p: string) => this.req('GET', p);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
  del = (p: string) => this.req('DELETE', p);
}
const admin = new Client();
const other = new Client();

before(async () => {
  db = await setupDb('podsovereign_sitebuild_test');
  hooks = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      res.writeHead(answer, { 'Content-Type': 'application/json' }).end(answer === 204 ? undefined : '{"id":"build_1"}');
    });
  });
  await new Promise<void>((r) => hooks.listen(0, '127.0.0.1', r));
  hookBase = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}`;
  buildEndpoints.github = hookBase;
  const config = testConfig({ mediaDir: await tempDir('sitebuild'), publicBaseUrl: 'http://feeds.mine.test' });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await admin.post('/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
  await admin.post('/api/admin/users', { email: 'sam@example.com', password: 'correct horse battery' });
  await other.post('/api/auth/login', { email: 'sam@example.com', password: 'correct horse battery' });
  show = (await admin.post('/api/podcasts', { title: 'WVEdTalk', slug: 'wvedtalk' })).json.podcast.id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => hooks.close(() => r()));
  await db.close();
});

const url = `/api/podcasts/${'{id}'}/site-build`;
const api = (suffix = '') => url.replace('{id}', show) + suffix;
const due = () => db.query(`UPDATE site_build_queue SET next_try_at = now() WHERE status = 'pending'`);
const CF = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/secret-hook-id';

test('settings: checked, secrets encrypted and never sent back; only the show’s team can see them', async () => {
  let r = await admin.get(api());
  assert.equal(r.json.enabled, false);
  assert.deepEqual(r.json.events, ['published', 'edited', 'deleted', 'scheduled']);
  assert.equal((await other.get(api())).status, 404, 'not on the team');
  assert.equal((await other.put(api(), { enabled: true })).status, 404);

  assert.equal((await admin.put(api(), { enabled: true })).status, 400, 'needs the details first');
  assert.match((await admin.put(api(), { service: 'cloudflare', fields: { url: 'http://insecure.example.com/hook' } })).json.error, /https/);
  assert.equal((await admin.put(api(), { service: 'github', fields: { owner: 'rgblack316', repo: 'site' } })).status, 400, 'token required');
  assert.equal((await admin.put(api(), { service: 'custom', fields: { url: 'https://x.example.com', body: '{not json' } })).status, 400);
  assert.equal((await admin.put(api(), { service: 'nope' })).status, 400);
  assert.equal((await admin.put(api(), { events: ['published', 'whenever'] })).status, 400);

  r = await admin.put(api(), { enabled: true, service: 'cloudflare', fields: { url: CF } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.saved.url, true);
  assert.ok(!r.text.includes('secret-hook-id'), 'the hook URL is never sent back');
  const stored = (await db.query<{ s: string }>(`SELECT secrets AS s FROM site_build_hooks WHERE podcast_id = $1`, [show])).rows[0]!.s;
  assert.match(stored, /^enc:v1:/);
  assert.ok(!stored.includes('secret-hook-id'));
  // Saving again without the URL keeps it; switching services needs that service's details.
  assert.equal((await admin.put(api(), { service: 'cloudflare', fields: {} })).json.saved.url, true);
  assert.equal((await admin.put(api(), { service: 'netlify', fields: {} })).status, 400);
});

test('Test sends the request now and records the result', async () => {
  got.length = 0;
  answer = 200;
  const r = await admin.post(api('/test'), { service: 'custom', fields: { url: `${hookBase}/hooks/rebuild?site=wv`, method: 'POST', headers: [{ name: 'X-Build-Key', value: 'k3y' }], body: '{"site":"wvedtalk"}' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.result, { ok: true, status: 200, detail: 'HTTP 200' });
  assert.equal(got[0]!.path, '/hooks/rebuild?site=wv');
  assert.equal(got[0]!.headers['x-build-key'], 'k3y');
  assert.equal(got[0]!.headers['content-type'], 'application/json');
  assert.equal(got[0]!.body, '{"site":"wvedtalk"}');
  assert.equal(r.json.history[0].trigger, 'test');
  assert.equal(r.json.service, 'cloudflare', 'testing doesn’t save');
});

test('a new episode, a scheduled one going live, edits and removals queue one build after the changes settle', async () => {
  await admin.put(api(), { enabled: true, service: 'custom', fields: { url: `${hookBase}/build`, method: 'POST' }, events: ['published', 'edited', 'deleted', 'scheduled'] });
  // Published now, and one scheduled earlier whose time has come.
  await db.query(
    `INSERT INTO episodes (podcast_id, guid, title, status, pub_date, updated_at, enclosure_url, enclosure_type, enclosure_length) VALUES
       ($1, 'ep-now', 'Published now', 'published', now() - interval '1 second', now(), 'https://cdn.example.com/a.mp3', 'audio/mpeg', 1000),
       ($1, 'ep-sched', 'Scheduled', 'scheduled', now() - interval '1 second', now() - interval '3 days', 'https://cdn.example.com/b.mp3', 'audio/mpeg', 1000)`,
    [show],
  );
  await announceDueEpisodes(db, testConfig());
  let q = (await db.query<{ events: string[]; n: Date }>(`SELECT events, next_try_at AS n FROM site_build_queue WHERE podcast_id = $1 AND status = 'pending'`, [show])).rows;
  assert.equal(q.length, 1, 'one build for both');
  assert.deepEqual([...q[0]!.events].sort(), ['published', 'scheduled']);
  assert.ok(q[0]!.n.getTime() > Date.now() + 30_000, 'waits for changes to settle');

  // Deleting an episode joins the same build.
  const ep = (await db.query<{ id: string }>(`SELECT id FROM episodes WHERE guid = 'ep-now'`)).rows[0]!.id;
  assert.ok([200, 204].includes((await admin.del(`/api/podcasts/${show}/episodes/${ep}`)).status));
  q = (await db.query<{ events: string[]; n: Date }>(`SELECT events, next_try_at AS n FROM site_build_queue WHERE podcast_id = $1 AND status = 'pending'`, [show])).rows;
  assert.equal(q.length, 1);
  assert.ok(q[0]!.events.includes('deleted'));

  // Editing a public episode too.
  const sched = (await db.query<{ id: string }>(`SELECT id FROM episodes WHERE guid = 'ep-sched'`)).rows[0]!.id;
  const ed = await admin.req('PATCH', `/api/podcasts/${show}/episodes/${sched}`, { title: 'Scheduled (fixed typo)' });
  assert.equal(ed.status, 200, ed.text);
  q = (await db.query<{ events: string[]; n: Date }>(`SELECT events, next_try_at AS n FROM site_build_queue WHERE podcast_id = $1 AND status = 'pending'`, [show])).rows;
  assert.equal(q.length, 1);
  assert.deepEqual([...q[0]!.events].sort(), ['deleted', 'edited', 'published', 'scheduled']);

  got.length = 0;
  assert.deepEqual(await sendDueBuilds(db), { sent: 0, failed: 0 }, 'not yet');
  await due();
  assert.deepEqual(await sendDueBuilds(db), { sent: 1, failed: 0 });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.path, '/build');
  const h = (await admin.get(api())).json.history[0];
  assert.equal(h.status, 'sent');
  assert.equal(h.lastStatus, 200);
});

test('events the show didn’t choose, a show with rebuilds off, and turning off', async () => {
  assert.equal(await queueBuild(db, show, 'show'), false, 'show-detail changes are off by default');
  await admin.put(api(), { events: ['published'] });
  assert.equal(await queueBuild(db, show, 'edited'), false);
  assert.equal(await queueBuild(db, show, 'published'), true);
  await admin.put(api(), { enabled: false });
  assert.equal((await db.query(`SELECT 1 FROM site_build_queue WHERE podcast_id = $1 AND status = 'pending'`, [show])).rowCount, 0, 'turning off drops a waiting build');
  assert.equal(await queueBuild(db, show, 'published'), false);
});

test('failures retry (3 attempts) and never show the hook address', async () => {
  await admin.put(api(), { enabled: true, service: 'custom', fields: { url: `${hookBase}/private-token-abc`, method: 'POST' }, events: ['published'] });
  answer = 500;
  await queueBuild(db, show, 'published');
  for (let i = 0; i < 3; i++) {
    await due();
    assert.deepEqual(await sendDueBuilds(db), { sent: 0, failed: 1 });
  }
  const h = (await admin.get(api())).json.history[0];
  assert.equal(h.status, 'failed');
  assert.equal(h.attempts, 3);
  assert.equal(h.lastStatus, 500);
  assert.ok(!JSON.stringify(h).includes('private-token-abc'));
  answer = 200;
});

test('Rebuild now, and GitHub Actions requests', async () => {
  answer = 204;
  got.length = 0;
  let r = await admin.put(api(), { enabled: true, service: 'github', fields: { owner: 'rgblack316', repo: 'wvedtalk-website', token: 'github_pat_SECRET', eventType: '' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.saved.token, true);
  assert.equal(r.json.settings.eventType, 'rebuild');
  r = await admin.post(api('/run'));
  assert.equal(r.json.history[0].trigger, 'manual');
  assert.deepEqual(await sendDueBuilds(db), { sent: 1, failed: 0 }, 'goes on the next pass, no wait');
  assert.equal(got[0]!.method, 'POST');
  assert.equal(got[0]!.path, '/repos/rgblack316/wvedtalk-website/dispatches');
  assert.equal(got[0]!.headers.authorization, 'Bearer github_pat_SECRET');
  assert.equal(got[0]!.headers.accept, 'application/vnd.github+json');
  assert.deepEqual(JSON.parse(got[0]!.body), { event_type: 'rebuild' });
  assert.equal((await admin.get(api())).json.history[0].lastStatus, 204);
  answer = 200;
});

test('a slow hook times out instead of hanging', async () => {
  const slow = http.createServer(() => { /* never answers */ });
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
  buildTiming.timeoutMs = 300;
  try {
    const r = await admin.post(api('/test'), { service: 'custom', fields: { url: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/x`, method: 'GET' } });
    assert.equal(r.json.result.ok, false);
    assert.match(r.json.result.detail, /No answer within/);
  } finally {
    buildTiming.timeoutMs = 30_000;
    slow.closeAllConnections();
    slow.close();
  }
});
