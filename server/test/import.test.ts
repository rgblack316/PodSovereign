import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { loadFeed } from '../src/db/podcasts.js';
import { buildFeed } from '../src/feed/builder.js';
import { claimNextJob, enqueueImport, mediaFilename, podcastGuidFor, runImportJob } from '../src/import/importer.js';
import { createUser, fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

let db: Db;
let host: Awaited<ReturnType<typeof startOldHost>>;
let mediaDir: string;
let alice: string;
let bob: string;

before(async () => {
  db = await setupDb('feedhost_import_test');
  host = await startOldHost();
  mediaDir = await tempDir('import-media');
  alice = await createUser(db, 'alice@example.com');
  bob = await createUser(db, 'bob@example.com');
});

after(async () => {
  await host.close();
  await db.close();
});

async function importNow(userId: string, url: string, cfg = {}) {
  const { id } = await enqueueImport(db, userId, url);
  const job = await claimNextJob(db);
  assert.equal(job?.id, id);
  await runImportJob({ db, config: testConfig({ mediaDir, ...cfg }) }, job!);
  const { rows } = await db.query<Record<string, any>>(`SELECT * FROM import_jobs WHERE id = $1`, [id]);
  return rows[0]!;
}

test('podcast:guid generation matches the Podcast Index spec example', () => {
  assert.equal(podcastGuidFor('https://mp3s.nashownotes.com/pc20rss.xml'), '917393e3-1b1e-5cef-ace4-edaa54e1f810');
  assert.equal(podcastGuidFor('http://mp3s.nashownotes.com/pc20rss.xml/'), '917393e3-1b1e-5cef-ace4-edaa54e1f810');
});

test('media filenames are safe and unique per URL', () => {
  const a = mediaFilename('https://x.com/a/My Episode (1).mp3');
  assert.match(a, /^[0-9a-f]{10}-My_Episode_1_.mp3$/);
  assert.notEqual(mediaFilename('https://x.com/a/ep.mp3'), mediaFilename('https://x.com/b/ep.mp3'));
  assert.match(mediaFilename('https://x.com/../../etc/passwd'), /^[0-9a-f]{10}-passwd$/);
});

test('imports a feed end to end: saves everything, copies media, rewrites URLs', async () => {
  host.feeds.set('main', fixtureOn(host.base, (x) => x.replace('length="34567890"', 'length="0"')));
  host.missing.add('/old/ep2.srt');

  const job = await importNow(alice, `${host.base}/moved.xml`);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.progress.stage, 'done');
  assert.equal(job.progress.mediaFailed, 1);
  assert.ok(job.warnings.some((w: string) => w.includes('redirected')), 'notes the redirect');
  assert.ok(job.warnings.some((w: string) => w.includes('ep2.srt')), 'reports the missing file');

  const { rows: pods } = await db.query<Record<string, any>>(`SELECT * FROM podcasts WHERE id = $1`, [job.podcast_id]);
  const pod = pods[0]!;
  assert.equal(pod.owner_id, alice);
  assert.equal(pod.slug, 'the-test-show-and-friends');
  assert.equal(pod.status, 'active');
  assert.equal(pod.podcast_guid, '917393e3-1b1e-5cef-ace4-edaa54e1f810');

  // Files on disk
  const { rows: media } = await db.query<Record<string, any>>(
    `SELECT * FROM media_files WHERE podcast_id = $1 ORDER BY original_url`,
    [job.podcast_id],
  );
  const done = media.filter((m) => m.status === 'done');
  assert.equal(done.length, media.length - 1);
  for (const m of done) {
    assert.ok(m.storage_path.startsWith(path.join(mediaDir, pod.slug)));
    assert.equal(await readFile(m.storage_path, 'utf8'), `content of ${new URL(m.original_url).pathname}`);
    assert.equal(m.bytes, (await stat(m.storage_path)).size);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(!media.some((m) => m.original_url.includes('stream.example.com')), 'live stream not downloaded');

  // Rebuilt feed points at our server, except the file that failed
  const feed = (await loadFeed(db, job.podcast_id))!;
  const xml = buildFeed(feed, { selfUrl: `https://feeds.mine.test/feeds/${pod.slug}.xml` });
  const leftovers = xml.split('\n').filter((l) => l.includes(`${host.base}/old/`)).map((l) => l.trim());
  assert.deepEqual(leftovers, [
    `<podcast:transcript url="${host.base}/old/ep2.srt" type="application/x-subrip" rel="captions"/>`, // copy failed
    `<guid>${host.base}/old/media/ep1.m4a</guid>`, // fallback GUID — must never change
  ]);
  assert.ok(xml.includes(`url="https://feeds.mine.test/media/${pod.slug}/`));
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[1]!.enclosureLength, `content of /old/media/ep1.m4a`.length, 'missing length filled in');
  assert.ok(feed.channel.extra.some((n) => n.name === 'podcast:value' && n.children.length === 2));
  assert.ok(feed.channel.extra.some((n) => n.name === 'fh:customThing'));
  assert.equal(feed.namespaces.fh, 'https://example.com/ns/custom');

  // Enclosures linked to their media rows
  const { rows: eps } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM episodes WHERE podcast_id = $1 AND enclosure_media_id IS NOT NULL`,
    [job.podcast_id],
  );
  assert.equal(eps[0]!.n, 2);
});

test('the DB round trip keeps the feed identical apart from rewritten media', async () => {
  host.feeds.set('rt', fixtureOn(host.base, (x) => x.replace('917393e3-1b1e-5cef-ace4-edaa54e1f810', 'aaaaaaaa-1b1e-5cef-ace4-edaa54e1f810')));
  const job = await importNow(alice, `${host.base}/feeds/rt.xml`);
  assert.equal(job.status, 'done', job.error);
  const a = (await loadFeed(db, job.podcast_id))!;
  const again = (await loadFeed(db, job.podcast_id))!;
  assert.deepEqual(again, a);
  assert.equal(a.channel.podcastLocked, false);
  assert.equal(a.channel.podcastLockedOwner, 'owner@example.com');
});

test('refuses duplicate imports, and imports of a show hosted by someone else', async () => {
  const mine = await importNow(alice, `${host.base}/feeds/main.xml`);
  assert.equal(mine.status, 'failed');
  assert.match(mine.error, /already imported/);

  const theirs = await importNow(bob, `${host.base}/feeds/main.xml`);
  assert.equal(theirs.status, 'failed');
  assert.match(theirs.error, /another account/);
});

test('refuses a locked feed', async () => {
  host.feeds.set('locked', fixtureOn(host.base, (x) =>
    x.replace('>no</podcast:locked>', '>yes</podcast:locked>').replace('917393e3', 'bbbbbbbb'),
  ));
  const job = await importNow(bob, `${host.base}/feeds/locked.xml`);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /locked/);
});

test('blocks private-network addresses unless explicitly allowed (SSRF guard)', async () => {
  const job = await importNow(bob, `${host.base}/feeds/main.xml`, { allowPrivateNetworks: false });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /private address 127\.0\.0\.1/);
});

test('rejects non-feeds and bad URLs', async () => {
  const job = await importNow(bob, `${host.base}/old/not-a-feed.html`);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /isn't a podcast RSS feed/);
  await assert.rejects(enqueueImport(db, bob, 'ftp://x.com/feed'), /http/);
  await assert.rejects(enqueueImport(db, bob, 'https://x.com/feed', { slug: 'Bad Slug!' }), /lowercase/);
});

test('resumes an interrupted import without re-downloading finished files', async () => {
  host.feeds.set('resume', fixtureOn(host.base, (x) => x.replace('917393e3', 'cccccccc').replace('<title>The Test Show', '<title>Resume Show')));
  const first = await importNow(bob, `${host.base}/feeds/resume.xml`);
  assert.equal(first.status, 'done', first.error);

  // Simulate a crash mid-copy: one file never finished, the podcast still "importing".
  // In a real crash the final rewrite never ran, so the stored feed still has the original URL.
  const { rows } = await db.query<{ id: string; original_url: string }>(
    `UPDATE media_files SET status = 'pending' WHERE podcast_id = $1 AND original_url LIKE '%/art-3000.jpg'
     RETURNING id, original_url`,
    [first.podcast_id],
  );
  await db.query(`UPDATE podcasts SET image_url = $2 WHERE id = $1`, [first.podcast_id, rows[0]!.original_url]);
  const redo = new URL(rows[0]!.original_url).pathname;
  await db.query(`UPDATE podcasts SET status = 'importing' WHERE id = $1`, [first.podcast_id]);
  await db.query(`UPDATE import_jobs SET status = 'queued' WHERE id = $1`, [first.id]);
  const before = new Map(host.hits);

  const job = await claimNextJob(db);
  await runImportJob({ db, config: testConfig({ mediaDir }) }, job!);
  const { rows: after } = await db.query<Record<string, any>>(`SELECT * FROM import_jobs WHERE id = $1`, [first.id]);
  assert.equal(after[0]!.status, 'done', after[0]!.error);

  const refetched = [...host.hits].filter(([u, n]) => n > (before.get(u) ?? 0)).map(([u]) => u);
  assert.deepEqual(refetched.filter((u) => !u.endsWith('ep2.srt')), [redo], 'only the unfinished file is downloaded again');
  const { rows: pod } = await db.query<{ status: string }>(`SELECT status FROM podcasts WHERE id = $1`, [first.podcast_id]);
  assert.equal(pod[0]!.status, 'active');
});
