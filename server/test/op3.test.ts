import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { isRefreshing, op3Timeouts, refreshDueOp3, refreshOp3, requestOp3Refresh, syncOp3Daily } from '../src/stats/op3.js';
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

const waitForRefresh = async (id: string) => {
  for (let i = 0; i < 200 && isRefreshing(id); i++) await new Promise((r) => setTimeout(r, 25));
};

test('first look starts a refresh; after that the saved numbers are shown without calling OP3', async () => {
  fake.requests.length = 0;
  let r = await admin.get(`/api/podcasts/${show}/op3`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.refreshing, true);
  await waitForRefresh(show);
  r = await admin.get(`/api/podcasts/${show}/op3`);
  const s = r.json;
  assert.equal(s.refreshing, false);
  assert.equal(s.counts.monthlyDownloads, 1234);
  assert.deepEqual(s.counts.weeklyDownloads, [250, 280, 320, 350]);
  assert.equal(s.episodes.length, 2);
  assert.equal(s.episodes[1].downloadsAll, 410);
  assert.deepEqual(s.apps.map((a: { name: string }) => a.name), ['Apple Podcasts', 'Spotify', 'Overcast'], 'most downloads first');
  assert.equal(s.statsPageUrl, `https://op3.dev/show/${UUID}`);
  assert.ok(s.countsAt && s.episodesAt && s.appsAt);
  assert.equal(Date.parse(s.nextRefreshAt) - Date.parse(s.refreshedAt), 6 * 3600_000, 'next refresh in 6 hours');
  assert.ok(fake.requests.every((q) => q.auth === `Bearer ${TOKEN}`), 'the token goes in the Authorization header');
  assert.ok(fake.requests.some((q) => q.path === `/api/1/shows/${knownGuid}`));
  assert.equal((await db.query<{ u: string }>(`SELECT op3_show_uuid AS u FROM podcasts WHERE id = $1`, [show])).rows[0]!.u, UUID, 'OP3 show ID saved');

  fake.requests.length = 0;
  assert.equal((await viewer.get(`/api/podcasts/${show}/op3`)).status, 404, 'not on the team');
  await admin.get(`/api/podcasts/${show}/op3`);
  await admin.get(`/api/podcasts/${show}/op3/daily?days=30`);
  assert.equal(fake.requests.length, 0, 'viewing never calls OP3');
});

test('one slow OP3 query doesn’t hold up or erase the others', async () => {
  op3Timeouts.query = 300;
  fake.delays.set('/api/1/queries/top-apps-for-show', 2000);
  fake.episodes[0]!.downloadsAll = 999;
  try {
    await refreshOp3(db, cfg(), show);
  } finally {
    op3Timeouts.query = 90_000;
    fake.delays.clear();
  }
  const s = (await admin.get(`/api/podcasts/${show}/op3`)).json;
  assert.equal(s.episodes[0].downloadsAll, 999, 'episodes updated');
  assert.match(s.appsError, /took too long/);
  assert.equal(s.apps.length, 3, 'the apps saved last time are still shown');
  assert.equal(s.countsError, null);
});

test('Refresh button: at most every 15 minutes', async () => {
  assert.equal(await requestOp3Refresh(db, cfg(), show), false, 'just refreshed');
  await db.query(`UPDATE podcasts SET op3_refreshed_at = now() - interval '20 minutes' WHERE id = $1`, [show]);
  assert.equal(await requestOp3Refresh(db, cfg(), show), true);
  await waitForRefresh(show);
  assert.equal((await admin.post(`/api/podcasts/${show}/op3/refresh`)).json.started, false);
});

test('the schedule: every 6 hours per show, sooner while a year of history is still being read', async () => {
  const now = new Date();
  await db.query(`UPDATE podcasts SET op3_synced_until = $2 WHERE id = $1`, [show, now]);
  await db.query(`UPDATE podcasts SET op3_refreshed_at = now() - interval '5 hours' WHERE id = $1`, [show]);
  assert.equal(await refreshDueOp3(db, cfg(), { now }), null, 'not due after 5 hours');
  await db.query(`UPDATE podcasts SET op3_refreshed_at = now() - interval '7 hours' WHERE id = $1`, [show]);
  assert.equal(await refreshDueOp3(db, cfg(), { now }), show, 'due after 6');
  // History still being read: picked up again after a short pause.
  await db.query(`UPDATE podcasts SET op3_refreshed_at = now() - interval '10 minutes', op3_synced_until = now() - interval '200 days' WHERE id = $1`, [show]);
  assert.equal(await refreshDueOp3(db, cfg(), { now, maxMs: 0 }), show);
});

test('a show OP3 hasn’t seen yet gets a plain explanation', async () => {
  const r = await admin.post('/api/podcasts', { title: 'Brand New', slug: 'brand-new' });
  const id = r.json.podcast.id;
  await assert.rejects(refreshOp3(db, cfg(), id), /hasn’t counted any downloads/);
  const s = (await admin.get(`/api/podcasts/${id}/op3`)).json;
  assert.equal(s.errorCode, 'not_found');
  assert.match(s.error, /hasn’t counted any downloads/);
  assert.ok(fake.requests.some((q) => q.path === `/api/1/shows/${Buffer.from('http://feeds.mine.test/brand-new/feed.xml').toString('base64url')}`));
});

test('daily downloads and countries: saved page by page, resumed after a failure, no double counting', async () => {
  const now = new Date('2026-10-21T15:00:00Z');
  const day = (n: number, h = 12) => new Date(Date.UTC(2026, 9, 21 - n, h)).toISOString();
  fake.downloads.length = 0;
  // 400 days back (only a year is read), a few a day, US and GB, plus one with no country.
  for (let n = 400; n >= 0; n--) for (let i = 0; i < (n % 3) + 1; i++) fake.downloads.push({ time: day(n, 8 + i), countryCode: i === 2 ? 'GB' : 'US' });
  fake.downloads.push({ time: day(0, 14), countryCode: null });
  // The daily view counts back from today (the real date), over what was synced up to `now`.
  const today = new Date();
  const expect = (from: number) => fake.downloads.filter((d) => Date.parse(d.time) >= Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - from) && Date.parse(d.time) < now.getTime()).length;
  await db.query(`UPDATE podcasts SET op3_synced_until = NULL, op3_backfill_until = NULL, op3_backfill_end = NULL, op3_history_at = NULL WHERE id = $1`, [show]);
  await db.query(`DELETE FROM op3_daily WHERE podcast_id = $1`, [show]);

  // OP3 fails partway (after the retry too): the pages already read are kept.
  fake.requests.length = 0;
  let calls = 0;
  const orig = fake.requests.push.bind(fake.requests);
  fake.requests.push = (...items) => {
    if (items[0]!.path.startsWith('/api/1/downloads') && ++calls === 4) fake.fail = { path: '/api/1/downloads', count: 2 };
    return orig(...items);
  };
  await assert.rejects(syncOp3Daily(db, cfg(), show, { now, pageSize: 100 }), /OP3 answered 500/);
  fake.requests.push = orig;
  const partial = (await db.query<{ u: Date; e: string }>(`SELECT op3_synced_until AS u, op3_sync_error AS e FROM podcasts WHERE id = $1`, [show])).rows[0]!;
  assert.ok(partial.u && partial.u.getTime() < now.getTime(), 'progress saved');
  assert.match(partial.e, /500/);
  const saved = (await db.query<{ n: number }>(`SELECT coalesce(sum(downloads), 0)::int AS n FROM op3_daily WHERE podcast_id = $1`, [show])).rows[0]!.n;
  assert.ok(saved > 0, 'the pages read before the failure are kept');

  // A time limit stops a long run cleanly; the next one carries on.
  await syncOp3Daily(db, cfg(), show, { now, pageSize: 100, maxPages: 2 });
  await syncOp3Daily(db, cfg(), show, { now, pageSize: 100 });
  const st = (await db.query<{ u: Date }>(`SELECT op3_synced_until AS u FROM podcasts WHERE id = $1`, [show])).rows[0]!.u;
  assert.equal(st.toISOString(), now.toISOString());
  assert.ok(fake.requests.some((q) => q.path.includes('continuationToken=')), 'follows continuation tokens');

  const r = await admin.get(`/api/podcasts/${show}/op3/daily?days=90`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.days.length, 90);
  assert.equal(r.json.total, expect(89));
  assert.deepEqual(r.json.countries.map((c: { code: string }) => c.code), ['US', 'GB', '']);
  assert.equal((await admin.get(`/api/podcasts/${show}/op3/daily?days=365`)).json.total, expect(364));
  assert.equal((await admin.get(`/api/podcasts/${show}/op3/daily?days=12`)).status, 400);

  // All time: the whole history (400 days here, older than the first year read) is in.
  const all = fake.downloads.filter((d) => Date.parse(d.time) < now.getTime()).length;
  let a = (await admin.get(`/api/podcasts/${show}/op3/daily?days=30`)).json;
  assert.equal(a.allTime, all);
  assert.equal(a.firstDay, day(400).slice(0, 10));
  assert.equal(a.historyComplete, true);
  assert.equal(a.backfillAt, null);

  // A month later the whole history is re-read, picking up OP3's corrections (two old downloads now counted as bots).
  fake.downloads.splice(fake.downloads.findIndex((d) => d.time.startsWith(day(380).slice(0, 10))), 1);
  fake.downloads.splice(fake.downloads.findIndex((d) => d.time.startsWith(day(200).slice(0, 10))), 1);
  await db.query(`UPDATE podcasts SET op3_history_at = $2::timestamptz - interval '31 days' WHERE id = $1`, [show, now]);
  await syncOp3Daily(db, cfg(), show, { now, pageSize: 100, maxPages: 3 });
  a = (await admin.get(`/api/podcasts/${show}/op3/daily?days=30`)).json;
  assert.equal(a.historyComplete, false, 'being re-read');
  assert.ok(a.backfillAt, 'shows how far back it has got');
  assert.ok(a.allTime >= all - 2 && a.allTime <= all, 'what was saved stays shown while it’s re-read');
  await syncOp3Daily(db, cfg(), show, { now, pageSize: 100 });
  a = (await admin.get(`/api/podcasts/${show}/op3/daily?days=30`)).json;
  assert.equal(a.allTime, all - 2);
  assert.equal(a.historyComplete, true);

  // New downloads arrive; the next sync re-reads only from the last day it had.
  fake.downloads.push({ time: '2026-10-21T16:00:00.000Z', countryCode: 'CA' }, { time: '2026-10-22T09:00:00.000Z', countryCode: 'CA' });
  fake.requests.length = 0;
  await syncOp3Daily(db, cfg(), show, { now: new Date('2026-10-22T12:00:00Z'), pageSize: 100 });
  assert.ok(fake.requests.filter((q) => q.path.startsWith('/api/1/downloads')).every((q) => q.path.includes('start=2026-10-21T00%3A00%3A00.000Z') || q.path.includes('startAfter')));
  const c = (await db.query<{ n: number }>(`SELECT sum(downloads)::int AS n FROM op3_daily WHERE podcast_id = $1 AND country = 'CA'`, [show])).rows[0]!.n;
  assert.equal(c, 2, 'no double counting of the re-read day');
});

test('a new show: the last year first, then everything older, all in one go when there’s time', async () => {
  const r = await admin.post('/api/podcasts', { title: 'History Show', slug: 'history-show' });
  const id = r.json.podcast.id;
  fake.guids.add(r.json.podcast.podcastGuid);
  fake.requests.length = 0;
  const now = new Date('2026-10-21T15:00:00Z');
  await syncOp3Daily(db, cfg(), id, { now, pageSize: 100 });
  const dl = fake.requests.filter((q) => q.path.startsWith('/api/1/downloads'));
  assert.match(dl[0]!.path, /start=2025-10-20T00%3A00%3A00.000Z/, 'the last year first');
  assert.ok(dl.some((q) => q.path.includes('start=2021-01-01T00%3A00%3A00.000Z')), 'then from the start of OP3');
  const p = (await db.query<{ e: Date | null; h: Date | null }>(`SELECT op3_backfill_end AS e, op3_history_at AS h FROM podcasts WHERE id = $1`, [id])).rows[0]!;
  assert.equal(p.e, null);
  assert.ok(p.h);
  const a = (await admin.get(`/api/podcasts/${id}/op3/daily?days=30`)).json;
  assert.equal(a.allTime, fake.downloads.filter((d) => Date.parse(d.time) < now.getTime()).length);
  assert.equal(a.historyComplete, true);
  const st = (await admin.get(`/api/podcasts/${id}/op3`)).json;
  assert.equal(st.allTime.downloads, a.allTime);
  assert.equal(st.allTime.complete, true);
});
