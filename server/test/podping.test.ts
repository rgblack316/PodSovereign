import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { buildFeed } from '../src/feed/builder.js';
import { parseFeed } from '../src/feed/parser.js';
import { claimNextJob, enqueueImport, runImportJob } from '../src/import/importer.js';
import { announceDueEpisodes, latestPings, queuePing, sendDuePings, setShowPodping, trimHistory } from '../src/podping/podping.js';
import { createUser, FIXTURE, fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

let db: Db;
let host: Awaited<ReturnType<typeof startOldHost>>;
let pingServer: http.Server;
let config: Config;
let user: string;
let podcastId: string;
let slug: string;
const received: { url: URL; auth: string | undefined }[] = [];
let nextStatus = 200;

before(async () => {
  db = await setupDb('feedhost_podping_test');
  host = await startOldHost();
  pingServer = http.createServer((req, res) => {
    received.push({ url: new URL(req.url!, 'http://x'), auth: req.headers.authorization });
    res.writeHead(nextStatus).end(nextStatus === 200 ? 'Success!' : 'nope');
  });
  await new Promise<void>((r) => pingServer.listen(0, '127.0.0.1', r));
  config = testConfig({
    mediaDir: await tempDir('podping-media'),
    podpingHubUrl: `http://127.0.0.1:${(pingServer.address() as AddressInfo).port}/pubnotify`,
  });
  user = await createUser(db, 'pinger@example.com');
});

after(async () => {
  await new Promise<void>((r) => pingServer.close(() => r()));
  await host.close();
  await db.close();
});

const pending = async () =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM podping_queue WHERE status = 'pending'`)).rows[0]!.n;

test('importing sends no ping: the show starts with Podping off', async () => {
  host.feeds.set('p', fixtureOn(host.base));
  await enqueueImport(db, user, `${host.base}/feeds/p.xml`);
  await runImportJob({ db, config }, (await claimNextJob(db))!);
  const { rows } = await db.query<{ id: string; slug: string; podping_enabled: boolean }>(`SELECT id, slug, podping_enabled FROM podcasts`);
  podcastId = rows[0]!.id;
  slug = rows[0]!.slug;
  assert.equal(rows[0]!.podping_enabled, false);
  assert.equal((await db.query(`SELECT 1 FROM podping_queue`)).rowCount, 0);
  assert.equal(await queuePing(db, config, podcastId), false, 'changes during the migration window are not announced');
  assert.equal(await announceDueEpisodes(db, config), 0);
});

test('turning the show switch on announces the feed once', async () => {
  await setShowPodping(db, config, podcastId, true);
  const { rows: q } = await db.query<Record<string, string>>(`SELECT feed_url, reason, status FROM podping_queue`);
  assert.deepEqual(q, [{ feed_url: `https://feeds.mine.test/${slug}/feed.xml`, reason: 'update', status: 'pending' }]);

  const r = await sendDuePings(db, config);
  assert.deepEqual(r, { sent: 1, failed: 0 });
  const ping = received.at(-1)!;
  assert.equal(ping.auth, undefined, 'no key is sent');
  assert.equal(ping.url.pathname, '/pubnotify');
  assert.equal(ping.url.searchParams.get('url'), `https://feeds.mine.test/${slug}/feed.xml`);
  assert.equal(ping.url.searchParams.get('podping'), '1');

  await setShowPodping(db, config, podcastId, true);
  assert.equal(await pending(), 0, 'already on: no extra ping');
});

test('turning the switch off cancels anything waiting and stops future pings', async () => {
  await queuePing(db, config, podcastId);
  assert.equal(await pending(), 1);
  await setShowPodping(db, config, podcastId, false);
  assert.equal(await pending(), 0);
  assert.equal(await queuePing(db, config, podcastId), false);
  await setShowPodping(db, config, podcastId, true);
  await sendDuePings(db, config);
});

test('a burst of changes becomes a single ping', async () => {
  assert.equal(await queuePing(db, config, podcastId), true);
  assert.equal(await queuePing(db, config, podcastId), false);
  assert.equal(await queuePing(db, config, podcastId), false);
  assert.equal(await pending(), 1);
  await sendDuePings(db, config);
  assert.equal(await pending(), 0);
});

test('failed pings are retried with backoff, then given up', async () => {
  nextStatus = 500;
  await queuePing(db, config, podcastId);
  assert.deepEqual(await sendDuePings(db, config), { sent: 0, failed: 1 });
  const { rows } = await db.query<{ attempts: number; status: string; wait: number; last_error: string }>(
    `SELECT attempts, status, extract(epoch FROM next_try_at - now())::int AS wait, last_error FROM podping_queue WHERE status = 'pending'`,
  );
  assert.equal(rows[0]!.attempts, 1);
  assert.ok(rows[0]!.wait >= 25 && rows[0]!.wait <= 30, `waits ~30s (${rows[0]!.wait})`);
  assert.match(rows[0]!.last_error, /HTTP 500/);
  assert.deepEqual(await sendDuePings(db, config), { sent: 0, failed: 0 }, 'not retried before its time');

  for (let i = 0; i < 5; i++) {
    await db.query(`UPDATE podping_queue SET next_try_at = now() WHERE status = 'pending'`);
    await sendDuePings(db, config);
  }
  const { rows: gave } = await db.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM podping_queue ORDER BY created_at DESC LIMIT 1`,
  );
  assert.deepEqual(gave[0], { status: 'failed', attempts: 6 });

  nextStatus = 200;
  await queuePing(db, config, podcastId);
  assert.deepEqual(await sendDuePings(db, config), { sent: 1, failed: 0 }, 'new changes still go out');
});

test('a scheduled episode triggers a ping when its publish time arrives', async () => {
  await db.query(
    `INSERT INTO episodes (podcast_id, guid, title, status, pub_date, enclosure_url)
     VALUES ($1, 'future-ep', 'Coming soon', 'scheduled', now() + interval '1 hour', 'https://x/a.mp3')`,
    [podcastId],
  );
  await db.query(`UPDATE podcasts SET feed_cache_xml = '<cached/>', feed_cache_etag = '"x"' WHERE id = $1`, [podcastId]);
  assert.equal(await announceDueEpisodes(db, config), 0, 'not yet');

  await db.query(`UPDATE episodes SET pub_date = now() - interval '1 second' WHERE guid = 'future-ep'`);
  assert.equal(await announceDueEpisodes(db, config), 1);
  assert.equal(await pending(), 1);
  const { rows } = await db.query<{ feed_cache_xml: string | null }>(`SELECT feed_cache_xml FROM podcasts WHERE id = $1`, [podcastId]);
  assert.equal(rows[0]!.feed_cache_xml, null, 'cached feed cleared so the episode appears');
  assert.equal(await announceDueEpisodes(db, config), 0, 'announced only once');
  await sendDuePings(db, config);
});

test('drafts are never announced', async () => {
  await db.query(
    `INSERT INTO episodes (podcast_id, guid, title, status, pub_date) VALUES ($1, 'draft-ep', 'Draft', 'draft', now() - interval '1 day')`,
    [podcastId],
  );
  assert.equal(await announceDueEpisodes(db, config), 0);
});

test('a refusal from the hub is logged and retried', async () => {
  const calls: { url: string; auth: string | undefined }[] = [];
  let answer = { status: 200, body: '{"status":"true","description":"Feed marked for immediate update."}' };
  const hub = http.createServer((req, res) => {
    calls.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(answer.body);
  });
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  const viaHub = { ...config, podpingHubUrl: `http://127.0.0.1:${(hub.address() as AddressInfo).port}/pubnotify` };
  try {
    await db.query(`DELETE FROM podping_queue`);
    assert.equal(await queuePing(db, viaHub, podcastId, 'live'), true);
    assert.deepEqual(await sendDuePings(db, viaHub), { sent: 1, failed: 0 });
    const u = new URL(calls[0]!.url, 'http://hub');
    assert.equal(u.pathname, '/pubnotify');
    assert.match(u.searchParams.get('url')!, /^https?:\/\/.+\/feed\.xml$/);
    assert.equal(u.searchParams.get('podping'), '1');
    assert.equal(calls[0]!.auth, undefined, 'no key is sent to the hub');

    answer = { status: 200, body: '{"status":"false","description":"Invalid feed url."}' };
    await queuePing(db, viaHub, podcastId, 'update');
    assert.deepEqual(await sendDuePings(db, viaHub), { sent: 0, failed: 1 });
    const { rows } = await db.query<{ status: string; last_error: string }>(`SELECT status, last_error FROM podping_queue WHERE reason = 'update'`);
    assert.equal(rows[0]!.status, 'pending');
    assert.match(rows[0]!.last_error, /Invalid feed url/);
  } finally {
    hub.close();
    await db.query(`DELETE FROM podping_queue`);
  }
});

test('each show keeps only its 5 most recent notifications; waiting ones are never trimmed', async () => {
  await db.query(`DELETE FROM podping_queue`);
  for (let i = 0; i < 8; i++) {
    await db.query(
      `INSERT INTO podping_queue (podcast_id, feed_url, reason, status, created_at, sent_at)
       VALUES ($1, 'https://x/feed.xml', 'update', 'sent', now() - make_interval(mins => $2), now())`,
      [podcastId, 60 - i],
    );
  }
  await db.query(`INSERT INTO podping_queue (podcast_id, feed_url, reason, status) VALUES ($1, 'https://x/feed.xml', 'update', 'pending')`, [podcastId]);
  await trimHistory(db);
  const { rows } = await db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM podping_queue GROUP BY status ORDER BY status`);
  assert.deepEqual(rows, [{ status: 'pending', n: 1 }, { status: 'sent', n: 5 }]);
  assert.equal((await latestPings(db, podcastId)).length, 5);
  await db.query(`DELETE FROM podping_queue`);
});

test('feeds advertise <podcast:podping> only when this server sends pings', () => {
  const withOldTag = FIXTURE.replace('<podcast:medium>', '<podcast:podping usesPodping="true"/>\n    <podcast:medium>');
  const { feed } = parseFeed(withOldTag);
  assert.ok(!feed.channel.extra.some((n) => n.name === 'podcast:podping'), "old host's tag is dropped");
  assert.ok(!buildFeed(feed).includes('podcast:podping'));
  const xml = buildFeed(feed, { usesPodping: true });
  assert.equal(xml.match(/<podcast:podping usesPodping="true"\/>/g)?.length, 1);
});

