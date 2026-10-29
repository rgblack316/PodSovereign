import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { readId3Chapters, writeId3Chapters } from '../src/media/id3.js';
import { setupDb, tempDir, testConfig } from './support/env.js';
import { mp3 } from './support/media-samples.js';
import { writeFile } from 'node:fs/promises';

let db: Db;
let server: http.Server;
let base: string;
let mediaDir: string;
let show: string;
let episode: string;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082', 'hex');

let cookie = '';
async function req(method: string, p: string, body?: unknown) {
  const raw = body instanceof Buffer;
  const res = await fetch(base + p, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: method === 'GET' ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body ?? {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}
async function upload(filename: string, body: Buffer, kind?: string) {
  const r = await req('POST', `/api/podcasts/${show}/uploads`, { filename, size: body.length, kind });
  const id = r.json.upload.id;
  await req('PUT', `/api/podcasts/${show}/uploads/${id}?offset=0`, body);
  const done = await req('POST', `/api/podcasts/${show}/uploads/${id}/complete`);
  assert.equal(done.status, 201, done.text);
  return done.json.media;
}
const feed = async () => (await fetch(`${base}/garden-talk/feed.xml`)).text();
const disk = (url: string) => path.join(mediaDir, new URL(url).pathname);

before(async () => {
  db = await setupDb('podsovereign_chapters_test');
  mediaDir = await tempDir('chapters-media');
  const config = testConfig({ mediaDir, publicBaseUrl: 'http://feeds.mine.test', mediaBaseUrl: 'http://feeds.mine.test' });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await req('POST', '/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
  show = (await req('POST', '/api/podcasts', { title: 'Garden Talk', slug: 'garden-talk' })).json.podcast.id;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

let audio: any;

test('an MP3 with chapters in its tags says so on upload, and they can be loaded into the editor', async () => {
  const dir = await tempDir('chapters-src');
  const plain = path.join(dir, 'plain.mp3');
  await writeFile(plain, mp3(400));
  const tagged = path.join(dir, 'tagged.mp3');
  await writeId3Chapters(plain, tagged, [
    { startTime: 0, endTime: null, title: 'Intro', url: null, image: null, toc: true },
    { startTime: 5, endTime: null, title: 'Tomatoes', url: 'https://example.com/tomatoes', image: { mime: 'image/png', data: PNG }, toc: true },
  ], 10);
  audio = await upload('episode-12.mp3', await readFile(tagged));
  assert.equal(audio.id3Chapters, 2);
  const plainUp = await upload('plain.mp3', await readFile(plain));
  assert.equal(plainUp.id3Chapters, undefined);

  const r = await req('POST', `/api/podcasts/${show}/episodes`, { title: 'Tomatoes', enclosure: { mediaId: audio.id }, status: 'published' });
  assert.equal(r.status, 201, r.text);
  episode = r.json.episode.id;

  // Saved into the episode, the upload took its exact name (episode-12.mp3) and a new media id.
  audio = { ...audio, id: r.json.episode.enclosure.mediaId, url: r.json.episode.enclosure.url };
  assert.match(audio.url, /\/audio\/episode-12\.mp3$/);
  const found = await req('POST', `/api/podcasts/${show}/media/${audio.id}/id3-chapters`);
  assert.equal(found.status, 200, found.text);
  assert.deepEqual(found.json.chapters.map((c: any) => [c.startTime, c.title, c.url, c.toc]), [[0, 'Intro', null, true], [5, 'Tomatoes', 'https://example.com/tomatoes', true]]);
  const img = found.json.chapters[1].img;
  assert.match(img, /^http:\/\/feeds\.mine\.test\/garden-talk\/media\/images\/.+\.png$/, 'the embedded image is saved as a file');
  assert.ok((await readFile(disk(img))).equals(PNG));
  const again = await req('POST', `/api/podcasts/${show}/media/${audio.id}/id3-chapters`);
  assert.equal(again.json.chapters[1].img, img, 'the same image is saved once');
});

test('the editor saves a JSON chapters file the feed points at; mistakes are explained', async () => {
  let r = await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters`);
  assert.deepEqual(r.json.chapters, []);
  assert.equal(r.json.audio.mp3, true);

  for (const [bad, msg] of [
    [[{ startTime: 0, title: '' }], /needs a title/],
    [[{ startTime: -1, title: 'x' }], /0 or more/],
    [[{ startTime: 5, title: 'a' }, { startTime: 5, title: 'b' }], /Two chapters start at 0:05/],
    [[{ startTime: 0, title: 'a', url: 'ftp://x' }], /https/],
  ] as const) {
    const b = await req('PUT', `/api/podcasts/${show}/episodes/${episode}/chapters`, { chapters: bad });
    assert.equal(b.status, 400);
    assert.match(b.json.error, msg);
  }

  const art = await upload('chapter-art.png', PNG);
  r = await req('PUT', `/api/podcasts/${show}/episodes/${episode}/chapters`, {
    chapters: [
      { startTime: 65.5, title: 'Planting', url: 'https://example.com/plant', img: { mediaId: art.id } },
      { startTime: 0, title: 'Welcome' },
      { startTime: 30, title: 'Sponsor', toc: false },
    ],
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.chapters.map((c: any) => [c.startTime, c.title, c.toc]), [[0, 'Welcome', true], [30, 'Sponsor', false], [65.5, 'Planting', true]], 'sorted by time');
  const xml = await feed();
  const url = /<podcast:chapters url="([^"]+)" type="application\/json\+chapters"\/>/.exec(xml)![1]!;
  assert.equal(url, r.json.url);
  const doc = JSON.parse(await readFile(disk(url), 'utf8'));
  assert.equal(doc.version, '1.2.0');
  assert.deepEqual(doc.chapters[2], { startTime: 65.5, title: 'Planting', img: art.url, url: 'https://example.com/plant' });
  assert.equal(doc.chapters[1].toc, false);

  // Saving again makes a new file and removes the old one.
  r = await req('PUT', `/api/podcasts/${show}/episodes/${episode}/chapters`, { chapters: [...doc.chapters.slice(0, 2), { ...doc.chapters[2], title: 'Planting time' }] });
  assert.notEqual(r.json.url, url);
  await assert.rejects(stat(disk(url)), 'old chapters file removed');
});

test('writing the chapters into the MP3: the same file name, replaced in place', async () => {
  const before = (await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode;
  const oldUrl = before.enclosure.url;
  let r = await req('PUT', `/api/podcasts/${show}/episodes/${episode}/chapters`, {
    chapters: [{ startTime: 0, title: 'Welcome' }, { startTime: 5, title: 'Planting time', img: (await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters`)).json.chapters[2].img }],
    writeToMp3: true,
  });
  assert.equal(r.status, 200, r.text);
  for (let i = 0; i < 100 && r.json.writing; i++) {
    await new Promise((res) => setTimeout(res, 50));
    r = await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters`);
  }
  assert.equal(r.json.mp3Write.status, 'done', r.json.mp3Write.error);
  const after = (await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode;
  assert.equal(after.enclosure.url, oldUrl, 'the same exact name (episode-12.mp3), replaced in place');
  const inside = await readId3Chapters(disk(after.enclosure.url));
  assert.deepEqual(inside.map((c) => [c.startTime, c.title]), [[0, 'Welcome'], [5, 'Planting time']]);
  assert.ok(inside[1]!.image!.data.equals(PNG), 'the chapter image is embedded');
  assert.equal(after.enclosure.length, (await stat(disk(after.enclosure.url))).size);
  const records = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM media_files WHERE public_path = $1`, [new URL(oldUrl).pathname])).rows[0]!.n;
  assert.equal(records, 1, 'one file at that address, replaced in place');
  assert.match(await feed(), new RegExp(`<enclosure url="${after.enclosure.url.replace(/[.]/g, '\\.')}"`));
});

test('removing every chapter removes the chapters tag', async () => {
  const r = await req('PUT', `/api/podcasts/${show}/episodes/${episode}/chapters`, { chapters: [] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.url, null);
  assert.doesNotMatch(await feed(), /podcast:chapters/);
});
