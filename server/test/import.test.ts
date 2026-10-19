import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { loadFeed, uniqueSlug } from '../src/db/podcasts.js';
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
  const xml = buildFeed(feed, { selfUrl: `https://feeds.mine.test/feed/${pod.slug}/feed.xml` });
  const leftovers = xml.split('\n').filter((l) => l.includes(`${host.base}/old/`)).map((l) => l.trim());
  assert.deepEqual(leftovers, [
    `<podcast:transcript url="${host.base}/old/ep2.srt" type="application/x-subrip" rel="captions"/>`, // copy failed
    `<guid>${host.base}/old/media/ep1.m4a</guid>`, // fallback GUID — must never change
  ]);
  assert.ok(xml.includes(`url="https://feeds.mine.test/${pod.slug}/media/audio/`));
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

test('copies images from show notes and chapter files, and stores files in per-type folders', async () => {
  const B = host.base;
  host.files.set('/old/ep2.chapters.json', {
    type: 'application/json+chapters',
    body: JSON.stringify({
      version: '1.2.0',
      chapters: [
        { startTime: 0, title: 'Intro', img: `${B}/old/chapters/intro.jpg` },
        { startTime: 60, title: 'Link only', url: `${B}/old/not-a-file` },
        { startTime: 120, title: 'Relative', img: 'local.jpg' },
      ],
    }),
  });
  host.feeds.set(
    'notes',
    fixtureOn(B, (x) =>
      x
        .replace('917393e3', 'dddddddd')
        .replace('<title>The Test Show', '<title>Notes Show')
        .replace(
          '<p>Show notes with a <a href="https://example.com">link</a>.</p>',
          `<p>Pic: <img src="${B}/old/notes/pic.jpg?w=600&amp;h=400" alt="x"> <a href="${B}/old/notes/page.html">page</a>` +
            `<img src="data:image/png;base64,iVBORw0KGgo="></p>`,
        )
        .replace(
          '<p>Longer notes</p>',
          `<p>Longer notes</p><picture><source srcset="${B}/old/notes/wide.webp 2x, ${B}/old/notes/narrow.webp 1x"><img src='${B}/old/notes/pic.jpg?w=600&amp;h=400'></picture>`,
        ),
    ),
  );

  const job = await importNow(bob, `${B}/feeds/notes.xml`);
  assert.equal(job.status, 'done', job.error);
  const { rows: pod } = await db.query<{ slug: string }>(`SELECT slug FROM podcasts WHERE id = $1`, [job.podcast_id]);
  const slug = pod[0]!.slug;
  const pub = `https://feeds.mine.test/${slug}/media/images/`;

  // Folder layout
  const dirs = (await readdir(path.join(mediaDir, slug))).sort();
  assert.deepEqual(dirs, ['audio', 'chapters', 'images', 'transcripts', 'video']);

  const { rows: media } = await db.query<{ original_url: string; kind: string; status: string; storage_path: string; bytes: number }>(
    `SELECT original_url, kind, status, storage_path, bytes FROM media_files WHERE podcast_id = $1`,
    [job.podcast_id],
  );
  const byUrl = new Map(media.map((m) => [m.original_url, m]));
  for (const u of ['/old/chapters/intro.jpg', '/old/notes/pic.jpg?w=600&h=400', '/old/notes/wide.webp', '/old/notes/narrow.webp']) {
    const m = byUrl.get(B + u);
    assert.ok(m, `copied ${u}`);
    assert.equal(m.status, 'done');
    assert.equal(m.kind, 'image');
    assert.ok(m.storage_path.includes(`/${slug}/images/`));
  }
  assert.ok(!byUrl.has(`${B}/old/notes/page.html`), 'plain links are not downloaded');
  assert.ok(!byUrl.has(`${B}/old/not-a-file`), 'chapter links are not downloaded');

  // Chapters file on disk now points at our copy; links and relative images untouched.
  const chapters = byUrl.get(`${B}/old/ep2.chapters.json`)!;
  const json = JSON.parse(await readFile(chapters.storage_path, 'utf8'));
  assert.ok(json.chapters[0].img.startsWith(pub), json.chapters[0].img);
  assert.equal(json.chapters[1].url, `${B}/old/not-a-file`);
  assert.equal(json.chapters[2].img, 'local.jpg');
  assert.equal(json.version, '1.2.0');
  assert.equal(chapters.bytes, (await stat(chapters.storage_path)).size);

  // Show notes rewritten; the same image used twice maps to one copy.
  const feed = (await loadFeed(db, job.podcast_id))!;
  const notes = feed.items[0]!.description!;
  const encoded = feed.items[0]!.extra.find((n) => n.name === 'content:encoded')!.text;
  const picCopy = notes.match(/<img src="([^"]+)"/)![1]!;
  assert.ok(picCopy.startsWith(pub));
  assert.ok(encoded.includes(`<img src="${picCopy}">`));
  assert.match(encoded, new RegExp(`srcset="${pub}[^"]+wide\\.webp 2x, ${pub}[^"]+narrow\\.webp 1x"`));
  assert.ok(notes.includes(`<a href="${B}/old/notes/page.html">`), 'links left alone');
  assert.ok(notes.includes('data:image/png;base64'), 'inline images left alone');
  assert.ok(notes.includes('alt="x"'));
});

test('show addresses that would collide with app routes are reserved', async () => {
  await assert.rejects(enqueueImport(db, bob, 'https://x.com/feed', { slug: 'feed' }), /reserved/);
  await assert.rejects(enqueueImport(db, bob, 'https://x.com/feed', { slug: 'api' }), /reserved/);
  assert.equal(await uniqueSlug(db, 'api'), 'api-2', 'a show titled "API" gets api-2');
  assert.equal(await uniqueSlug(db, 'my-show'), 'my-show');
});
