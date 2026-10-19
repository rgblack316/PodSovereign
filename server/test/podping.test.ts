import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { buildFeed } from '../src/feed/builder.js';
import { parseFeed } from '../src/feed/parser.js';
import { claimNextJob, enqueueImport, runImportJob } from '../src/import/importer.js';
import { announceDueEpisodes, podpingMedium, queuePing, sendDuePings, setShowPodping } from '../src/podping/podping.js';
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
    podpingToken: 'test-token',
    podpingUrl: `http://127.0.0.1:${(pingServer.address() as AddressInfo).port}/`,
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
  const { rows: q } = await db.query<Record<string, string>>(`SELECT feed_url, reason, medium, status FROM podping_queue`);
  assert.deepEqual(q, [{ feed_url: `https://feeds.mine.test/${slug}/feed.xml`, reason: 'update', medium: 'podcast', status: 'pending' }]);

  const r = await sendDuePings(db, config);
  assert.deepEqual(r, { sent: 1, failed: 0 });
  const ping = received.at(-1)!;
  assert.equal(ping.auth, 'test-token');
  assert.equal(ping.url.searchParams.get('url'), `https://feeds.mine.test/${slug}/feed.xml`);
  assert.equal(ping.url.searchParams.get('reason'), 'update');
  assert.equal(ping.url.searchParams.get('medium'), 'podcast');

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

test('with no PODPING_TOKEN nothing is queued or sent', async () => {
  const off = { ...config, podpingToken: null };
  assert.equal(await queuePing(db, off, podcastId), false);
  assert.equal(await pending(), 0);
  assert.deepEqual(await sendDuePings(db, off), { sent: 0, failed: 0 });
});

test('feeds advertise <podcast:podping> only when this server sends pings', () => {
  const withOldTag = FIXTURE.replace('<podcast:medium>', '<podcast:podping usesPodping="true"/>\n    <podcast:medium>');
  const { feed } = parseFeed(withOldTag);
  assert.ok(!feed.channel.extra.some((n) => n.name === 'podcast:podping'), "old host's tag is dropped");
  assert.ok(!buildFeed(feed).includes('podcast:podping'));
  const xml = buildFeed(feed, { usesPodping: true });
  assert.equal(xml.match(/<podcast:podping usesPodping="true"\/>/g)?.length, 1);
});

test('medium mapping', () => {
  assert.equal(podpingMedium('music'), 'music');
  assert.equal(podpingMedium('Video'), 'video');
  assert.equal(podpingMedium(null), 'podcast');
  assert.equal(podpingMedium('something-new'), 'podcast');
});
