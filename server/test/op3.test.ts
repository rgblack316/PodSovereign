import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { clearOp3Cache, syncOp3Daily } from '../src/stats/op3.js';
import { setupDb, tempDir, testConfig } from './support/env.js';
import { startFakeOp3, type FakeOp3 } from './support/fake-op3.js';

const TOKEN = 'op3-test-token-123';
const UUID = 'aabbccddeeff00112233445566778899';
let db: Db;
let server: http.Server;
let fake: FakeOp3;
let config: ReturnType<typeof testConfig>;
const cfg = () => config;
let base: string;
let knownGuid = '';
const requests = { reset: () => (fake.requests.length = 0) };

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
}
const admin = new Client();
const viewer = new Client();
let show: string;

before(async () => {
  db = await setupDb('podsovereign_op3_test');
  fake = await startFakeOp3({ token: TOKEN, uuid: UUID });
  config = testConfig({ mediaDir: await tempDir('op3'), publicBaseUrl: 'http://feeds.mine.test', op3ApiUrl: fake.apiUrl });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await admin.post('/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
  await admin.post('/api/admin/users', { email: 'sam@example.com', password: 'correct horse battery' });
  await viewer.post('/api/auth/login', { email: 'sam@example.com', password: 'correct horse battery' });
  const r = await admin.post('/api/podcasts', { title: 'Garden Talk', slug: 'garden-talk' });
  show = r.json.podcast.id;
  knownGuid = r.json.podcast.podcastGuid;
  fake.guids.add(knownGuid);
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fake.close();
  await db.close();
});

test('the OP3 Stats tab appears only for shows using the OP3 prefix', async () => {
  assert.equal((await admin.get(`/api/podcasts/${show}`)).json.podcast.op3, false);
  assert.equal((await admin.put(`/api/podcasts/${show}/prefixes`, { settings: [{ serviceKey: 'op3', enabled: true }] })).status, 200);
  assert.equal((await admin.get(`/api/podcasts/${show}`)).json.podcast.op3, true);
});

test('without a token, the stats say an administrator needs to add one', async () => {
  const r = await admin.get(`/api/podcasts/${show}/op3`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'no_token');
});

test('admins save the token (checked, encrypted, never sent back)', async () => {
  assert.equal((await admin.post('/api/admin/site/test-op3', { token: 'wrong-token-xyz' })).status, 502);
  assert.equal((await admin.post('/api/admin/site/test-op3', { token: TOKEN })).json.ok, true);
  assert.equal((await viewer.put('/api/admin/site', { op3Token: TOKEN })).status, 403);
  const r = await admin.put('/api/admin/site', { op3Token: TOKEN });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.op3.tokenSet, true);
  assert.ok(!r.text.includes(TOKEN));
  const stored = (await db.query<{ t: string }>(`SELECT op3_token AS t FROM site_settings WHERE id`)).rows[0]!.t;
  assert.match(stored, /^enc:v1:/);
});

test('stats: found by podcast:guid, then downloads, episodes and apps', async () => {
  requests.reset();
  const r = await admin.get(`/api/podcasts/${show}/op3`);
  assert.equal(r.status, 200, r.text);
  const s = r.json;
  assert.equal(s.showUuid, UUID);
  assert.equal(s.monthlyDownloads, 1234);
  assert.deepEqual(s.weeklyDownloads, [250, 280, 320, 350]);
  assert.equal(s.episodes.length, 2);
  assert.equal(s.episodes[1].downloadsAll, 410);
  assert.deepEqual(s.apps.map((a: { name: string }) => a.name), ['Apple Podcasts', 'Spotify', 'Overcast'], 'most downloads first');
  assert.equal(s.statsPageUrl, `https://op3.dev/show/${UUID}`);
  assert.ok(fake.requests.every((q) => q.auth === `Bearer ${TOKEN}`), 'the token goes in the Authorization header');
  assert.ok(fake.requests.some((q) => q.path === `/api/1/shows/${knownGuid}`));
  assert.equal((await db.query<{ u: string }>(`SELECT op3_show_uuid AS u FROM podcasts WHERE id = $1`, [show])).rows[0]!.u, UUID, 'OP3 show ID saved');

  // Cached: a second look doesn't call OP3 again; refresh does.
  requests.reset();
  await viewer.get(`/api/podcasts/${show}/op3`).then((x) => assert.equal(x.status, 404, 'not on the team'));
  await admin.get(`/api/podcasts/${show}/op3`);
  assert.equal(fake.requests.length, 0);
  await admin.get(`/api/podcasts/${show}/op3?refresh=1`);
  assert.ok(fake.requests.some((q) => q.path === `/api/1/shows/${UUID}`), 'uses the saved OP3 ID');
});

test('a show OP3 hasn’t seen yet gets a plain explanation', async () => {
  clearOp3Cache();
  const r = await admin.post('/api/podcasts', { title: 'Brand New', slug: 'brand-new' });
  const id = r.json.podcast.id;
  const s = await admin.get(`/api/podcasts/${id}/op3`);
  assert.equal(s.status, 404);
  assert.equal(s.json.code, 'not_found');
  assert.match(s.json.error, /hasn’t counted any downloads/);
  // It tried the guid and then the feed address (base64url).
  assert.ok(fake.requests.some((q) => q.path === `/api/1/shows/${Buffer.from('http://feeds.mine.test/brand-new/feed.xml').toString('base64url')}`));
});

test('daily downloads and countries: summed from OP3’s records, then kept up to date', async () => {
  const now = new Date('2026-10-21T15:00:00Z');
  const day = (n: number, h = 12) => new Date(Date.UTC(2026, 9, 21 - n, h)).toISOString();
  fake.downloads.length = 0;
  // 400 days back (only a year is read), a few a day, US and GB, plus one with no country.
  for (let n = 400; n >= 0; n--) for (let i = 0; i < (n % 3) + 1; i++) fake.downloads.push({ time: day(n, 8 + i), countryCode: i === 2 ? 'GB' : 'US' });
  fake.downloads.push({ time: day(0, 14), countryCode: null });
  const expect = (from: number) => fake.downloads.filter((d) => Date.parse(d.time) >= Date.UTC(2026, 9, 21 - from) && Date.parse(d.time) < now.getTime()).length;

  fake.requests.length = 0;
  // Small pages force paging (the real page is 20,000); cap the pages to also test resuming.
  await syncOp3Daily(db, cfg(), show, { now, maxPages: 3, pageSize: 100 });
  let st = (await db.query<{ u: Date }>(`SELECT op3_synced_until AS u FROM podcasts WHERE id = $1`, [show])).rows[0]!.u;
  assert.ok(st.getTime() < now.getTime(), 'stopped part way');
  await syncOp3Daily(db, cfg(), show, { now, maxPages: 1000, pageSize: 100 });
  st = (await db.query<{ u: Date }>(`SELECT op3_synced_until AS u FROM podcasts WHERE id = $1`, [show])).rows[0]!.u;
  assert.equal(st.toISOString(), now.toISOString());
  assert.ok(fake.requests.some((q) => q.path.includes('continuationToken=')), 'follows continuation tokens');

  const r = await admin.get(`/api/podcasts/${show}/op3/daily?days=90`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.days.length, 90);
  assert.equal(r.json.days.at(-1).day, '2026-10-21');
  assert.equal(r.json.total, expect(89));
  assert.deepEqual(r.json.countries.map((c: { code: string }) => c.code), ['US', 'GB', '']);
  const yr = await admin.get(`/api/podcasts/${show}/op3/daily?days=365`);
  assert.equal(yr.json.total, expect(364));
  assert.equal((await admin.get(`/api/podcasts/${show}/op3/daily?days=12`)).status, 400);

  // New downloads arrive; the next sync only re-reads from the last day it had.
  fake.downloads.push({ time: '2026-10-21T16:00:00.000Z', countryCode: 'CA' }, { time: '2026-10-22T09:00:00.000Z', countryCode: 'CA' });
  fake.requests.length = 0;
  await syncOp3Daily(db, cfg(), show, { now: new Date('2026-10-22T12:00:00Z'), maxPages: 1000, pageSize: 100 });
  assert.ok(fake.requests.filter((q) => q.path.startsWith('/api/1/downloads')).every((q) => q.path.includes('start=2026-10-21T00%3A00%3A00.000Z') || q.path.includes('continuationToken')));
  const c = (await db.query<{ n: number }>(`SELECT sum(downloads)::int AS n FROM op3_daily WHERE podcast_id = $1 AND country = 'CA'`, [show])).rows[0]!.n;
  assert.equal(c, 2, 'no double counting of the re-read day');
});
