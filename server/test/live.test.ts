import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { loadFeed } from '../src/db/podcasts.js';
import { buildFeed } from '../src/feed/builder.js';
import { parseFeed } from '../src/feed/parser.js';
import { claimNextJob, enqueueImport, runImportJob } from '../src/import/importer.js';
import { createLiveItem, deleteLiveItem, listLiveItems, setLiveStatus, updateLiveItem } from '../src/live/live.js';
import { sendDuePings, setShowPodping } from '../src/podping/podping.js';
import { createUser, fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

let db: Db;
let host: Awaited<ReturnType<typeof startOldHost>>;
let pingServer: http.Server;
let config: Config;
let podcastId: string;
const pings: { podping: string | null; url: string | null }[] = [];

before(async () => {
  db = await setupDb('feedhost_live_test');
  host = await startOldHost();
  pingServer = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    pings.push({ podping: u.searchParams.get('podping'), url: u.searchParams.get('url') });
    res.writeHead(200).end('Success!');
  });
  await new Promise<void>((r) => pingServer.listen(0, '127.0.0.1', r));
  config = testConfig({
    mediaDir: await tempDir('live-media'),
    podpingHubUrl: `http://127.0.0.1:${(pingServer.address() as AddressInfo).port}/pubnotify`,
  });
  const user = await createUser(db, 'live@example.com');
  // An imported live item that also carries a tag we don't manage (podcast:chat).
  host.feeds.set(
    'live',
    fixtureOn(host.base, (x) =>
      x.replace(
        '<podcast:contentLink href="https://youtube.com/live/abc">Watch on YouTube</podcast:contentLink>',
        '<podcast:contentLink href="https://youtube.com/live/abc">Watch on YouTube</podcast:contentLink>\n' +
          '      <podcast:chat server="irc.zeronode.net" protocol="irc" space="#live"/>',
      ),
    ),
  );
  await enqueueImport(db, user, `${host.base}/feeds/live.xml`);
  await runImportJob({ db, config }, (await claimNextJob(db))!);
  podcastId = (await db.query<{ id: string }>(`SELECT id FROM podcasts`)).rows[0]!.id;
  await setShowPodping(db, config, podcastId, true);
  await sendDuePings(db, config);
  pings.length = 0;
});

after(async () => {
  await new Promise<void>((r) => pingServer.close(() => r()));
  await host.close();
  await db.close();
});

const feedXml = async () => buildFeed((await loadFeed(db, podcastId))!, { usesPodping: true });
const queued = async () =>
  (await db.query<{ reason: string }>(`SELECT reason FROM podping_queue WHERE status = 'pending' ORDER BY created_at`)).rows.map((r) => r.reason);

test('imported live items are listed with their fields', async () => {
  const [li] = await listLiveItems(db, podcastId);
  assert.ok(li);
  assert.equal(li.status, 'pending');
  assert.equal(li.title, 'Live Q&A');
  assert.equal(li.guid, 'live-2026-11-01');
  assert.equal(li.start, '2026-11-01T19:00:00-04:00');
  assert.equal(li.streamUrl, 'https://stream.example.com/live.mp3');
  assert.deepEqual(li.contentLinks, [{ href: 'https://youtube.com/live/abc', text: 'Watch on YouTube' }]);
  assert.deepEqual(li.otherTags, ['podcast:chat']);
});

test('validation', async () => {
  const base = { title: 'Show', start: '2026-11-08T19:00:00-05:00', streamUrl: 'https://s.example/live' };
  await assert.rejects(createLiveItem(db, podcastId, { ...base, title: ' ' }), /Title is required/);
  await assert.rejects(createLiveItem(db, podcastId, { ...base, start: 'next tuesday' }), /Start must be a date/);
  await assert.rejects(createLiveItem(db, podcastId, { ...base, streamUrl: undefined }), /Stream URL is required/);
  await assert.rejects(createLiveItem(db, podcastId, { ...base, streamUrl: 'ftp://x/y' }), /http\(s\) URL/);
  await assert.rejects(createLiveItem(db, podcastId, { ...base, end: '2026-11-08T18:00:00-05:00' }), /End must be after start/);
  await assert.rejects(createLiveItem(db, podcastId, { ...base, streamType: 'not a type' }), /MIME type/);
});

let newId: string;

test('a new live item appears in the feed as pending', async () => {
  const li = await createLiveItem(db, podcastId, {
    title: 'Election Night Live',
    description: '<p>Results as they come in</p>',
    start: '2026-11-03T20:00:00-05:00',
    end: '2026-11-03T23:00:00-05:00',
    streamUrl: 'https://icecast.example/live.mp3',
    contentLinks: [{ href: 'https://youtube.com/live/xyz', text: 'Watch on YouTube' }],
  });
  newId = li.id;
  assert.equal(li.status, 'pending');
  assert.match(li.guid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await queued(), [], 'creating a pending item sends no ping');

  const xml = await feedXml();
  assert.ok(xml.includes('<podcast:liveItem status="pending" start="2026-11-03T20:00:00-05:00" end="2026-11-03T23:00:00-05:00">'));
  assert.ok(xml.includes('<title>Election Night Live</title>'));
  assert.ok(xml.includes('<description><![CDATA[<p>Results as they come in</p>]]></description>'));
  assert.ok(xml.includes(`<guid isPermaLink="false">${li.guid}</guid>`));
  assert.ok(xml.includes('<enclosure url="https://icecast.example/live.mp3" type="audio/mpeg" length="0"/>'));
  assert.ok(xml.includes('<podcast:contentLink href="https://youtube.com/live/xyz">Watch on YouTube</podcast:contentLink>'));
  assert.deepEqual(parseFeed(xml).warnings, [], 'well-formed');
});

test('going live updates the feed and notifies the hub (logged as "live")', async () => {
  const now = new Date('2026-11-03T20:01:00-05:00');
  const li = await setLiveStatus(db, config, podcastId, newId, 'live', now);
  assert.equal(li.status, 'live');
  assert.equal(li.start, '2026-11-03T20:00:00-05:00', 'start already passed: kept');
  assert.deepEqual(await queued(), ['live']);
  assert.ok((await feedXml()).includes('<podcast:liveItem status="live" start="2026-11-03T20:00:00-05:00"'));

  await sendDuePings(db, config);
  assert.equal(pings.at(-1)!.podping, '1');
  assert.match(pings.at(-1)!.url!, /\/feed\.xml$/);
});

test('going live early moves the start time to now', async () => {
  const early = await createLiveItem(db, podcastId, { title: 'Early', start: '2030-01-01T00:00:00Z', streamUrl: 'https://s/x' });
  const now = new Date('2029-12-31T23:50:00Z');
  const li = await setLiveStatus(db, config, podcastId, early.id, 'live', now);
  assert.equal(li.start, now.toISOString());
  await setLiveStatus(db, config, podcastId, early.id, 'ended', new Date('2029-12-31T23:59:00Z'));
  await deleteLiveItem(db, config, podcastId, early.id);
  await db.query(`DELETE FROM podping_queue WHERE status = 'pending'`);
});

test('ending notifies the hub (logged as "liveEnd") and stamps the real end time', async () => {
  const now = new Date('2026-11-03T22:15:00-05:00');
  const li = await setLiveStatus(db, config, podcastId, newId, 'ended', now);
  assert.equal(li.status, 'ended');
  assert.equal(li.end, now.toISOString(), 'scheduled end was later, so it becomes the real end');
  assert.deepEqual(await queued(), ['liveEnd']);
  await sendDuePings(db, config);
  assert.equal(pings.at(-1)!.podping, '1');

  await setLiveStatus(db, config, podcastId, newId, 'ended', now);
  assert.deepEqual(await queued(), [], 'already ended: no second ping');
});

test('rejects unknown statuses and unknown ids', async () => {
  await assert.rejects(setLiveStatus(db, config, podcastId, newId, 'broadcasting'), /pending, live or ended/);
  await assert.rejects(setLiveStatus(db, config, podcastId, '00000000-0000-0000-0000-000000000000', 'live'), /not found/);
  await assert.rejects(updateLiveItem(db, podcastId, 'nope', { title: 'x' }), /not found/);
});

test('editing an imported live item keeps tags we do not manage', async () => {
  const [imported] = (await listLiveItems(db, podcastId)).filter((l) => l.guid === 'live-2026-11-01');
  const li = await updateLiveItem(db, podcastId, imported!.id, { title: 'Live Q&A — rescheduled', start: '2026-11-02T19:00:00-04:00', end: '2026-11-02T20:00:00-04:00' });
  assert.equal(li.title, 'Live Q&A — rescheduled');
  assert.equal(li.guid, 'live-2026-11-01', 'guid never changes');
  assert.deepEqual(li.otherTags, ['podcast:chat']);
  const xml = await feedXml();
  assert.ok(xml.includes('<podcast:chat server="irc.zeronode.net" protocol="irc" space="#live"/>'));
  assert.ok(xml.includes('<guid>live-2026-11-01</guid>'), 'original guid attributes kept');
});

test('the feed round-trips: re-importing what we serve gives the same live items', async () => {
  const xml = await feedXml();
  const again = parseFeed(xml).feed.channel.extra.filter((n) => n.name === 'podcast:liveItem');
  const stored = (await loadFeed(db, podcastId))!.channel.extra.filter((n) => n.name === 'podcast:liveItem');
  assert.deepEqual(again, stored);
});

test('removing a live item that is live counts as the show ending', async () => {
  const li = await createLiveItem(db, podcastId, { title: 'Pop-up', start: '2026-11-05T12:00:00Z', streamUrl: 'https://s/p' });
  await setLiveStatus(db, config, podcastId, li.id, 'live', new Date('2026-11-05T12:00:00Z'));
  await db.query(`DELETE FROM podping_queue WHERE status = 'pending'`);
  await deleteLiveItem(db, config, podcastId, li.id);
  assert.deepEqual(await queued(), ['liveEnd']);
  assert.ok(!(await feedXml()).includes('Pop-up'));
});

test('with the show switch off, status changes still update the feed but send no pings', async () => {
  await db.query(`DELETE FROM podping_queue WHERE status = 'pending'`);
  await setShowPodping(db, config, podcastId, false);
  const li = await createLiveItem(db, podcastId, { title: 'Quiet', start: '2026-11-06T12:00:00Z', streamUrl: 'https://s/q' });
  await setLiveStatus(db, config, podcastId, li.id, 'live', new Date('2026-11-06T12:00:00Z'));
  assert.deepEqual(await queued(), []);
  assert.ok((await feedXml()).includes('<title>Quiet</title>'));
});
