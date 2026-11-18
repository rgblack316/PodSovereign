import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { startFakePodChapters, type FakePodChapters } from './support/fake-podchapters.js';
import { setupDb, tempDir, testConfig } from './support/env.js';
import { mp3 } from './support/media-samples.js';

let db: Db;
let server: http.Server;
let base: string;
let fake: FakePodChapters;
let config: ReturnType<typeof testConfig>;
let show: string;
let episode: string;
const SRT = '1\n00:00:00,000 --> 00:00:02,500\nWelcome to Randy Unscripted.\n\n2\n00:00:02,500 --> 00:00:05,000\nToday: tomatoes.\n';

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
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}
async function upload(filename: string, body: Buffer) {
  const r = await req('POST', `/api/podcasts/${show}/uploads`, { filename, size: body.length });
  const id = r.json.upload.id;
  await req('PUT', `/api/podcasts/${show}/uploads/${id}?offset=0`, body);
  return (await req('POST', `/api/podcasts/${show}/uploads/${id}/complete`)).json.media;
}
const generate = () => req('POST', `/api/podcasts/${show}/episodes/${episode}/chapters/generate`);
const saved = async () => (await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters`)).json.chapters;

before(async () => {
  db = await setupDb('podsovereign_podchapters_test');
  const mediaDir = await tempDir('podchapters-media');
  fake = await startFakePodChapters('pck_test_key_12345');
  config = testConfig({ mediaDir, publicBaseUrl: 'http://feeds.mine.test', mediaBaseUrl: 'http://feeds.mine.test', podchaptersUrl: fake.url });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await req('POST', '/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
  show = (await req('POST', '/api/podcasts', { title: 'Randy Unscripted', slug: 'randy-unscripted' })).json.podcast.id;
  await req('PUT', `/api/podcasts/${show}/details`, { author: 'Randy Black', language: 'en-us', link: 'https://randyunscripted.example.com' });
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fake.close();
  await db.close();
});

test('the API key: checked, encrypted, never sent back', async () => {
  assert.equal((await req('POST', '/api/admin/site/test-podchapters', { key: 'pck_wrong_key_999' })).status, 424);
  const t = await req('POST', '/api/admin/site/test-podchapters', { key: fake.key });
  assert.deepEqual(t.json.account, { plan: 'Smart', credits: 120.5, canMakeChapters: true });
  const r = await req('PUT', '/api/admin/site', { podchaptersKey: fake.key });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.podchapters.keySet, true);
  assert.ok(!r.text.includes(fake.key));
  const row = (await db.query<{ k: string }>(`SELECT podchapters_key AS k FROM site_settings WHERE id`)).rows[0]!;
  assert.match(row.k, /^enc:v1:/);
});

test('per-show style settings', async () => {
  let r = await req('GET', `/api/podcasts/${show}/podchapters`);
  assert.deepEqual(r.json.settings, { style: 'balance', count: 'moderate', ads: false, links: false });
  r = await req('PUT', `/api/podcasts/${show}/podchapters`, { style: 'strict', count: 'more', ads: true });
  assert.deepEqual(r.json.settings, { style: 'strict', count: 'more', ads: true, links: false });
  assert.equal((await req('PUT', `/api/podcasts/${show}/podchapters`, { style: 'wild' })).status, 400);
});

test('asking for chapters: the episode’s own transcript goes to PodChapters; the chapters come back unsaved', async () => {
  const audio = await upload('ru053.mp3', mp3(300));
  let r = await req('POST', `/api/podcasts/${show}/episodes`, { title: 'Tomatoes', episode: 53, enclosure: { mediaId: audio.id }, status: 'draft' });
  assert.equal(r.status, 201, r.text);
  episode = r.json.episode.id;

  // No transcript yet: nothing is sent and nothing is spent.
  r = await generate();
  assert.equal(r.status, 409);
  assert.match(r.json.error, /no transcript/);
  assert.equal(fake.episodes.size, 0);

  const srt = await upload('ru053.srt', Buffer.from(SRT));
  r = await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { transcripts: [{ mediaId: srt.id, type: 'application/x-subrip', rel: 'captions' }] });
  assert.equal(r.status, 200, r.text);

  fake.chapters = [{ start: 4, title: 'Welcome' }, { start: 95.5, title: 'Staking', url: 'https://example.com/stakes' }, { start: 300, title: 'Ad: Sponsor', toc: false }];
  r = await generate();
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.chapters, [
    { startTime: 0, title: 'Welcome', url: null, img: null, toc: true },
    { startTime: 95.5, title: 'Staking', url: 'https://example.com/stakes', img: null, toc: true },
    { startTime: 300, title: 'Ad: Sponsor', url: null, img: null, toc: false },
  ], 'the first chapter starts at 0');
  assert.equal(r.json.credits, 0.2);

  const pc = fake.episodes.get('pc1')!;
  assert.equal(pc.filename, 'ru053.mp3', 'named after the audio file');
  assert.equal(pc.request.audio_url, 'http://feeds.mine.test/randy-unscripted/media/audio/ru053.mp3');
  assert.deepEqual(pc.request.metadata, { title: 'Tomatoes', podcast_name: 'Randy Unscripted', artist: 'Randy Black', episode_number: 53 });
  assert.equal(pc.request.import_tags, false);
  assert.equal(pc.transcript, SRT, 'Auphonic’s transcript is sent, so PodChapters never transcribes (no cost)');
  assert.deepEqual(pc.generated, [{ mode: 'suggest', title_style: 'strict', chapter_count: 'more', detect_ads: true, link_urls: false }]);
  assert.deepEqual(await saved(), [], 'nothing is saved until the podcaster saves them in the editor');
});

test('a second request reuses the PodChapters copy; a deleted copy is made again; errors say what happened', async () => {
  let r = await generate();
  assert.equal(r.status, 200, r.text);
  assert.equal(fake.episodes.size, 1, 'no second copy');
  assert.equal(fake.episodes.get('pc1')!.generated.length, 2);

  fake.episodes.delete('pc1');
  r = await generate();
  assert.equal(r.status, 200, r.text);
  assert.equal(fake.episodes.size, 1);
  assert.ok(fake.episodes.has('pc2'));

  // The audio was replaced (a reprocess): PodChapters can't swap audio, so a new copy is made under a dated name.
  await db.query(`UPDATE media_files SET sha256 = 'changed', bytes = bytes + 1 WHERE podcast_id = $1 AND public_path = '/randy-unscripted/media/audio/ru053.mp3'`, [show]);
  r = await generate();
  assert.equal(r.status, 200, r.text);
  assert.equal(fake.episodes.size, 2);
  assert.match([...fake.episodes.values()].at(-1)!.filename, /^ru053-\d{14}\.mp3$/);
  r = await generate();
  assert.equal(fake.episodes.size, 2, 'unchanged audio reuses that copy');

  fake.failNext = { status: 402, code: 'insufficient_credits', message: 'Not enough credits.', hint: 'This needs 0.2 credits.' };
  r = await generate();
  assert.equal(r.status, 424);
  assert.match(r.json.error, /Not enough credits\. This needs 0\.2 credits\./);

  assert.equal((await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters/generate`)).json.configured, true);
});
