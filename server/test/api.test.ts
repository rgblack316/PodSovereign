import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { claimNextJob, runImportJob } from '../src/import/importer.js';
import { fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

let db: Db;
let server: http.Server;
let base: string;
let host: Awaited<ReturnType<typeof startOldHost>>;
let mediaDir: string;
let config: ReturnType<typeof testConfig>;

/** Tiny browser-like client with a cookie jar. */
class Client {
  cookie = '';
  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body !== undefined || !['GET', 'HEAD'].includes(method) ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? (['GET', 'HEAD'].includes(method) ? undefined : '{}') : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers, text };
  }
  get = (p: string, h?: Record<string, string>) => this.req('GET', p, undefined, h);
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.req('POST', p, b ?? {}, h);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);
}

const alice = new Client();
const bob = new Client();
const anon = new Client();
let alicePodcast: string;
let aliceJob: string;
let slug: string;

before(async () => {
  db = await setupDb('feedhost_api_test');
  host = await startOldHost();
  host.feeds.set('main', fixtureOn(host.base));
  mediaDir = await tempDir('api-media');
  config = testConfig({ mediaDir, allowRegistration: false, publicBaseUrl: 'http://feeds.mine.test', mediaBaseUrl: 'http://feeds.mine.test' });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await host.close();
  await db.close();
});

describe('accounts', () => {
  test('the first account becomes admin; then registration is closed', async () => {
    const r = await alice.post('/api/auth/register', { email: 'Alice@Example.com', password: 'correct horse battery' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.user.isAdmin, true);
    assert.equal(r.json.user.email, 'alice@example.com');
    assert.match(r.headers.get('set-cookie')!, /fh_session=.+; Path=\/; HttpOnly; SameSite=Lax/);

    const r2 = await bob.post('/api/auth/register', { email: 'bob@example.com', password: 'another long password' });
    assert.equal(r2.status, 403);
    assert.match(r2.json.error, /Registration is closed/);
  });

  test('admin creates accounts; others cannot', async () => {
    const weak = await alice.post('/api/admin/users', { email: 'bob@example.com', password: 'short' });
    assert.equal(weak.status, 400);
    const r = await alice.post('/api/admin/users', { email: 'bob@example.com', password: 'another long password' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.user.isAdmin, false);
    const dup = await alice.post('/api/admin/users', { email: 'BOB@example.com', password: 'another long password' });
    assert.equal(dup.status, 409);

    const login = await bob.post('/api/auth/login', { email: 'bob@example.com', password: 'another long password' });
    assert.equal(login.status, 200);
    const denied = await bob.post('/api/admin/users', { email: 'eve@example.com', password: 'another long password' });
    assert.equal(denied.status, 403);
  });

  test('passwords are stored hashed, sessions as token hashes', async () => {
    const { rows } = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users`);
    for (const r of rows) assert.match(r.password_hash, /^scrypt\$32768\$8\$1\$/);
    const token = alice.cookie.split('=')[1]!;
    const { rows: s } = await db.query<{ id: string }>(`SELECT id FROM sessions`);
    assert.ok(s.every((x) => x.id !== token && /^[0-9a-f]{64}$/.test(x.id)));
  });

  test('wrong passwords are rejected and rate limited', async () => {
    await alice.post('/api/admin/users', { email: 'carol@example.com', password: 'carols long password' });
    const eve = new Client();
    const ip = { 'X-Real-IP': '198.51.100.7' }; // trusted because the test proxy hop is local
    const tryLogin = (email: string, password: string) => eve.post('/api/auth/login', { email, password }, ip);
    const r = await tryLogin('carol@example.com', 'wrong password!');
    assert.equal(r.status, 401);
    assert.equal(r.json.error, 'Email or password is incorrect');
    const unknown = await tryLogin('nobody@example.com', 'wrong password!');
    assert.equal(unknown.json.error, r.json.error, 'same message for unknown accounts');
    for (let i = 0; i < 8; i++) await tryLogin('carol@example.com', 'wrong password!');
    const locked = await tryLogin('carol@example.com', 'carols long password');
    assert.equal(locked.status, 429, 'even the right password is refused while locked out');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    // Other people from other addresses are unaffected.
    const fine = await new Client().post('/api/auth/login', { email: 'bob@example.com', password: 'another long password' });
    assert.equal(fine.status, 200);
  });

  test('behind Cloudflare Tunnel, lockouts follow the real visitor (CF-Connecting-IP), not the tunnel', async () => {
    await alice.post('/api/admin/users', { email: 'dave@example.com', password: 'daves long password' });
    const attacker = new Client();
    const fromA = { 'CF-Connecting-IP': '203.0.113.50' };
    for (let i = 0; i < 10; i++) {
      await attacker.post('/api/auth/login', { email: `guess${i}@example.com`, password: 'wrong password!' }, fromA);
    }
    const blocked = await attacker.post('/api/auth/login', { email: 'dave@example.com', password: 'daves long password' }, fromA);
    assert.equal(blocked.status, 429, 'attacker address is locked out');
    const realUser = await new Client().post(
      '/api/auth/login',
      { email: 'dave@example.com', password: 'daves long password' },
      { 'CF-Connecting-IP': '198.51.100.20' },
    );
    assert.equal(realUser.status, 200, 'everyone else through the same tunnel still gets in');
  });

  test('anonymous users get 401 from the API', async () => {
    for (const p of ['/api/me', '/api/podcasts', '/api/imports']) assert.equal((await anon.get(p)).status, 401, p);
  });

  test('state-changing requests must be same-origin JSON (CSRF)', async () => {
    const form = await alice.req('POST', '/api/imports', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(form.status, 415);
    const evil = await alice.post('/api/imports', { url: 'https://x.com/feed' }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const crossSite = await alice.post('/api/imports', { url: 'https://x.com/feed' }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    // The dashboard opened at http://localhost:8080 (e.g. an SSH port-forward) before the public address works.
    const local = await alice.post('/api/me/password', { currentPassword: 'x', newPassword: 'y' }, { Origin: 'http://localhost:8080' });
    assert.notEqual(local.status, 415);
    assert.notEqual(local.json.error, 'Cross-site request blocked');
    const lookalike = await alice.post('/api/imports', { url: 'https://x.com/feed' }, { Origin: 'http://localhost.evil.example' });
    assert.equal(lookalike.status, 403);
  });
});

describe('importing and per-user isolation', () => {
  test('alice imports a podcast through the API', async () => {
    const r = await alice.post('/api/imports', { url: `${host.base}/feeds/main.xml` });
    assert.equal(r.status, 202, r.text);
    aliceJob = r.json.job.id;
    assert.equal(r.json.job.status, 'queued');

    const job = await claimNextJob(db);
    await runImportJob({ db, config }, job!);

    const done = await alice.get(`/api/imports/${aliceJob}`);
    assert.equal(done.json.job.status, 'done', JSON.stringify(done.json));
    alicePodcast = done.json.job.podcastId;

    const list = await alice.get('/api/podcasts');
    assert.equal(list.json.podcasts.length, 1);
    slug = list.json.podcasts[0].slug;
    assert.equal(list.json.podcasts[0].role, 'owner');
    assert.equal(list.json.podcasts[0].feedUrl, `http://feeds.mine.test/${slug}/feed.xml`);
  });

  test("bob can't see, change or delete alice's podcast — every route answers 404", async () => {
    assert.deepEqual((await bob.get('/api/podcasts')).json.podcasts, []);
    assert.deepEqual((await bob.get('/api/imports')).json.jobs, []);
    const attempts = [
      bob.get(`/api/podcasts/${alicePodcast}`),
      bob.get(`/api/podcasts/${alicePodcast}/episodes`),
      bob.get(`/api/podcasts/${alicePodcast}/prefixes`),
      bob.put(`/api/podcasts/${alicePodcast}/prefixes`, { settings: [{ serviceKey: 'op3', enabled: true }] }),
      bob.del(`/api/podcasts/${alicePodcast}`),
      bob.get(`/api/imports/${aliceJob}`),
      bob.get('/api/podcasts/not-a-uuid'),
      bob.get('/api/podcasts/00000000-0000-0000-0000-000000000000'),
    ];
    for (const r of await Promise.all(attempts)) assert.equal(r.status, 404, r.text);
    // Nothing changed for alice.
    assert.deepEqual((await alice.get(`/api/podcasts/${alicePodcast}/prefixes`)).json.settings, []);
    assert.equal((await alice.get(`/api/podcasts/${alicePodcast}`)).status, 200);
  });

  test('shared access: a viewer can read but not edit, and only the owner can delete', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'bob@example.com'`);
    await db.query(`INSERT INTO podcast_members (podcast_id, user_id, role) VALUES ($1, $2, 'viewer')`, [alicePodcast, rows[0]!.id]);
    assert.equal((await bob.get(`/api/podcasts/${alicePodcast}`)).json.podcast.role, 'viewer');
    assert.equal((await bob.put(`/api/podcasts/${alicePodcast}/prefixes`, { settings: [] })).status, 403);

    await db.query(`UPDATE podcast_members SET role = 'editor' WHERE podcast_id = $1`, [alicePodcast]);
    assert.equal((await bob.put(`/api/podcasts/${alicePodcast}/prefixes`, { settings: [] })).status, 200);
    assert.equal((await bob.del(`/api/podcasts/${alicePodcast}`)).status, 403);
    await db.query(`DELETE FROM podcast_members WHERE podcast_id = $1`, [alicePodcast]);
    assert.equal((await bob.get(`/api/podcasts/${alicePodcast}`)).status, 404, 'access removed');
  });
});

describe('stats prefixes and the public feed', () => {
  test('the prefix checkboxes change the public feed', async () => {
    const feed1 = await anon.get(`/${slug}/feed.xml`);
    assert.equal(feed1.status, 200);
    assert.match(feed1.headers.get('content-type')!, /application\/rss\+xml/);
    assert.ok(feed1.text.includes(`url="http://feeds.mine.test/${slug}/media/audio/`));
    assert.ok(feed1.text.includes(`<atom:link href="http://feeds.mine.test/${slug}/feed.xml" rel="self"`));

    const r = await alice.put(`/api/podcasts/${alicePodcast}/prefixes`, {
      settings: [
        { serviceKey: 'op3', enabled: true, position: 0 },
        { serviceKey: 'podtrac', enabled: true, position: 1 },
        { serviceKey: 'magellan', enabled: false, position: 2 },
      ],
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.chain, ['https://op3.dev/e/', 'https://dts.podtrac.com/redirect.mp3/']);

    const feed2 = await anon.get(`/${slug}/feed.xml`);
    assert.ok(feed2.text.includes(`url="https://op3.dev/e/dts.podtrac.com/redirect.mp3/feeds.mine.test/${slug}/media/audio/`));
    assert.notEqual(feed2.headers.get('etag'), feed1.headers.get('etag'));
  });

  test('the Podping switch: off after import, editors can turn it on, outsiders get 404', async () => {
    const st = await alice.get(`/api/podcasts/${alicePodcast}/podping`);
    assert.equal(st.status, 200);
    assert.equal(st.json.enabled, false);
    assert.equal((await bob.put(`/api/podcasts/${alicePodcast}/podping`, { enabled: true })).status, 404);
    assert.equal((await alice.put(`/api/podcasts/${alicePodcast}/podping`, { enabled: 'yes' })).status, 400);
    const on = await alice.put(`/api/podcasts/${alicePodcast}/podping`, { enabled: true });
    assert.equal(on.json.enabled, true);
    assert.ok((await anon.get(`/${slug}/feed.xml`)).text.includes('<podcast:podping usesPodping="true"/>'));
    await alice.put(`/api/podcasts/${alicePodcast}/podping`, { enabled: false });
  });

  test('invalid prefix settings are rejected and nothing changes', async () => {
    const r = await alice.put(`/api/podcasts/${alicePodcast}/prefixes`, {
      settings: [{ serviceKey: 'magellan', enabled: true, paramValue: '' }],
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Account ID is required/);
    const now = await alice.get(`/api/podcasts/${alicePodcast}/prefixes`);
    assert.deepEqual(now.json.settings.filter((s: any) => s.enabled).map((s: any) => s.serviceKey), ['op3', 'podtrac']);
  });

  test('feeds support ETag / 304', async () => {
    const a = await anon.get(`/${slug}/feed.xml`);
    const b = await anon.get(`/${slug}/feed.xml`, { 'If-None-Match': a.headers.get('etag')! });
    assert.equal(b.status, 304);
  });

  test('unknown feeds 404', async () => {
    assert.equal((await anon.get('/nope/feed.xml')).status, 404);
  });

  test('media is served with byte ranges (dev server)', async () => {
    const { rows } = await db.query<{ public_path: string; bytes: number }>(
      `SELECT public_path, bytes FROM media_files WHERE podcast_id = $1 AND status = 'done' AND kind = 'audio' LIMIT 1`,
      [alicePodcast],
    );
    const full = await anon.get(rows[0]!.public_path);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    const part = await anon.get(rows[0]!.public_path, { Range: 'bytes=0-6' });
    assert.equal(part.status, 206);
    assert.equal(part.text, 'content');
    assert.equal(part.headers.get('content-range'), `bytes 0-6/${rows[0]!.bytes}`);
    assert.equal((await anon.get(`/${slug}/media/audio/..%2F..%2Fetc%2Fpasswd`)).status, 404);
    assert.equal((await anon.get(`/${slug}/media/secrets/x.mp3`)).status, 404, 'unknown type folder');
  });
});

describe('dashboard support', () => {
  test('setup status is public; the dashboard and its files are served with a strict CSP', async () => {
    const s = await anon.get('/api/setup');
    assert.equal(s.json.needsFirstAccount, false);
    assert.equal(s.json.registrationOpen, false);
    assert.equal(s.json.publicBaseUrl, 'http://feeds.mine.test');
    assert.equal(s.json.siteName, 'FeedHost');
    const page = await anon.get('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await anon.get('/app/app.js')).status, 200);
    assert.equal((await anon.get('/app/styles.css')).status, 200);
    for (const p of ['/app/..%2Fpackage.json', '/app/nope.js', '/app/']) assert.equal((await anon.get(p)).status, 404, p);
  });

  test('admins can list people; others cannot', async () => {
    const r = await alice.get('/api/admin/users');
    assert.equal(r.status, 200);
    assert.ok(r.json.users.some((u: any) => u.email === 'bob@example.com' && u.podcasts === 0));
    assert.ok(!JSON.stringify(r.json).includes('scrypt'), 'no password hashes');
    assert.equal((await bob.get('/api/admin/users')).status, 403);
  });

  test('podcast detail carries what the signal lights need', async () => {
    const { podcast: p } = (await alice.get(`/api/podcasts/${alicePodcast}`)).json;
    assert.equal(p.status, 'active');
    assert.ok(p.media.done > 0);
    assert.equal(p.media.failed, 0);
    assert.equal(p.episodeCount, 2);
    assert.deepEqual(p.podping, { enabled: false });
    assert.equal(p.redirect.status, null);
    const list = (await alice.get('/api/podcasts')).json.podcasts[0];
    assert.equal(list.imported, true);
    assert.equal(list.podpingEnabled, false);
  });

  test('the 301 check: none → temporary → elsewhere → ok', async () => {
    const check = async () => (await alice.post(`/api/podcasts/${alicePodcast}/redirect-check`)).json;
    const ours = `http://feeds.mine.test/${slug}/feed.xml`;

    let r = await check();
    assert.equal(r.result.status, 'none');

    host.redirects.set('/feeds/main.xml', [302, ours]);
    r = await check();
    assert.equal(r.result.status, 'temporary');
    assert.match(r.result.detail, /permanent \(301\)/);

    host.redirects.set('/feeds/main.xml', [301, `${host.base}/hop`]);
    host.redirects.set('/hop', [301, `${host.base}/old/elsewhere.xml`]);
    r = await check();
    assert.equal(r.result.status, 'elsewhere');

    host.redirects.set('/feeds/main.xml', [301, `${host.base}/hop`]);
    host.redirects.set('/hop', [301, ours]);
    r = await check();
    assert.equal(r.result.status, 'ok', JSON.stringify(r.result));
    assert.equal(r.podcast.redirect.status, 'ok', 'saved for the dashboard');
    assert.equal((await bob.post(`/api/podcasts/${alicePodcast}/redirect-check`)).status, 404);
    host.redirects.clear();
  });
});

describe('live items over the API', () => {
  test('owner manages live items; other users get 404', async () => {
    const created = await alice.post(`/api/podcasts/${alicePodcast}/live`, {
      title: 'Live Studio Session',
      start: '2026-11-10T19:00:00-05:00',
      streamUrl: 'https://icecast.example/studio.mp3',
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.liveItem.id;

    const bad = await alice.post(`/api/podcasts/${alicePodcast}/live`, { title: 'x' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Start time is required/);

    for (const r of await Promise.all([
      bob.get(`/api/podcasts/${alicePodcast}/live`),
      bob.post(`/api/podcasts/${alicePodcast}/live`, { title: 'x', start: '2026-11-10T19:00:00Z', streamUrl: 'https://s/x' }),
      bob.req('PATCH', `/api/podcasts/${alicePodcast}/live/${id}`, { title: 'hijacked' }),
      bob.post(`/api/podcasts/${alicePodcast}/live/${id}/status`, { status: 'live' }),
      bob.del(`/api/podcasts/${alicePodcast}/live/${id}`),
    ])) assert.equal(r.status, 404, r.text);

    const live = await alice.post(`/api/podcasts/${alicePodcast}/live/${id}/status`, { status: 'live' });
    assert.equal(live.status, 200, live.text);
    assert.equal(live.json.liveItem.status, 'live');
    assert.ok((await anon.get(`/${slug}/feed.xml`)).text.includes('<podcast:liveItem status="live"'));

    const edited = await alice.req('PATCH', `/api/podcasts/${alicePodcast}/live/${id}`, { title: 'Live Studio Session (extended)' });
    assert.equal(edited.json.liveItem.title, 'Live Studio Session (extended)');
    assert.equal((await alice.get(`/api/podcasts/${alicePodcast}/live`)).json.liveItems.filter((l: any) => l.id === id).length, 1);
    assert.equal((await alice.post(`/api/podcasts/${alicePodcast}/live/${id}/status`, { status: 'paused' })).status, 400);
    assert.equal((await alice.del(`/api/podcasts/${alicePodcast}/live/${id}`)).status, 204);
    assert.equal((await alice.post(`/api/podcasts/${alicePodcast}/live/${id}/status`, { status: 'live' })).status, 404);
  });
});

describe('sessions', () => {
  test('changing password signs out other sessions', async () => {
    const laptop = new Client();
    await laptop.post('/api/auth/login', { email: 'bob@example.com', password: 'another long password' });
    assert.equal((await laptop.get('/api/me')).status, 200);

    const wrong = await bob.post('/api/me/password', { currentPassword: 'nope nope nope', newPassword: 'brand new password' });
    assert.equal(wrong.status, 403);
    const ok = await bob.post('/api/me/password', { currentPassword: 'another long password', newPassword: 'brand new password' });
    assert.equal(ok.status, 204, ok.text);

    assert.equal((await laptop.get('/api/me')).status, 401, 'other session revoked');
    assert.equal((await bob.get('/api/me')).status, 200, 'current session kept');
  });

  test('logout ends the session', async () => {
    const c = new Client();
    await c.post('/api/auth/login', { email: 'bob@example.com', password: 'brand new password' });
    const cookie = c.cookie;
    assert.equal((await c.post('/api/auth/logout')).status, 204);
    const reused = new Client();
    reused.cookie = cookie;
    assert.equal((await reused.get('/api/me')).status, 401, 'old cookie no longer works');
  });
});

describe('deleting', () => {
  test('owner deletes the podcast: data, feed and copied media are gone', async () => {
    const dir = path.join(mediaDir, slug);
    assert.ok(existsSync(dir));
    assert.equal((await alice.del(`/api/podcasts/${alicePodcast}`)).status, 204);
    assert.equal((await alice.get(`/api/podcasts/${alicePodcast}`)).status, 404);
    assert.equal((await anon.get(`/${slug}/feed.xml`)).status, 404);
    assert.ok(!existsSync(dir));
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM episodes WHERE podcast_id = $1`, [alicePodcast]);
    assert.equal(rows[0]!.n, 0);
  });
});
