import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { speechLanguage, srtToVtt, srtToText, srtToJson, vttToSrt } from '../src/auphonic/auphonic.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { startFakeAuphonic, type FakeAuphonic } from './support/fake-auphonic.js';
import { setupDb, tempDir, testConfig } from './support/env.js';
import { mp3 } from './support/media-samples.js';

let db: Db;
let server: http.Server;
let base: string;
let mediaDir: string;
let fake: FakeAuphonic;
let config: ReturnType<typeof testConfig>;
let show: string;
let episode: string;
let original: any;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082', 'hex');
const PROCESSED = mp3(300);
const SRT = '1\n00:00:00,000 --> 00:00:02,500\nWelcome to Garden Talk.\n\n2\n00:00:02,500 --> 00:00:05,000\nToday: tomatoes.\n';

let cookie = '';
async function req(method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(base + p, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
    body: method === 'GET' ? undefined : raw ? new Uint8Array(body as Buffer) : typeof body === 'string' ? body : JSON.stringify(body ?? {}),
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
const feed = async () => (await fetch(`${base}/garden-talk/feed.xml`)).text();
const disk = (url: string) => path.join(mediaDir, new URL(url).pathname);
const waitFor = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };
const processing = async () => (await req('GET', `/api/podcasts/${show}/episodes/${episode}/process`)).json.processing;

before(async () => {
  db = await setupDb('podsovereign_auphonic_test');
  mediaDir = await tempDir('auphonic-media');
  fake = await startFakeAuphonic('auph-key-12345');
  fake.outputs.set('mp3', { body: PROCESSED, format: 'mp3', ending: 'mp3', filename: 'garden-talk-12-tomatoes.mp3' });
  fake.outputs.set('srt', { body: Buffer.from(SRT), format: 'subtitle', ending: 'srt', filename: 'garden-talk-12-tomatoes.srt' });
  fake.outputs.set('txt', { body: Buffer.from('Welcome to Garden Talk. Today: tomatoes.\n'), format: 'transcript', ending: 'txt', filename: 'garden-talk-12-tomatoes.txt' });
  config = testConfig({ mediaDir, publicBaseUrl: 'http://feeds.mine.test', mediaBaseUrl: 'http://feeds.mine.test', auphonicUrl: fake.url });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await req('POST', '/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
  show = (await req('POST', '/api/podcasts', { title: 'Garden Talk', slug: 'garden-talk' })).json.podcast.id;
  await req('PUT', `/api/podcasts/${show}/details`, { author: 'Johns Creek Studios', ownerName: 'Randy Black', language: 'en-us', link: 'https://gardentalk.example.com' });
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await fake.close();
  await db.close();
});

test('the API key: checked, encrypted, never sent back', async () => {
  assert.equal((await req('POST', '/api/admin/site/test-auphonic', { key: 'wrong-key-123' })).status, 424);
  assert.equal((await req('POST', '/api/admin/site/test-auphonic', { key: fake.key })).json.account, 'randy');
  const r = await req('PUT', '/api/admin/site', { auphonicKey: fake.key });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.auphonic.keySet, true);
  assert.ok(!r.text.includes(fake.key));
  const row = (await db.query<{ k: string; t: string }>(`SELECT auphonic_key AS k, auphonic_hook_token AS t FROM site_settings WHERE id`)).rows[0]!;
  assert.match(row.k, /^enc:v1:/);
  assert.match(row.t, /^[0-9a-f]{48}$/, 'a secret callback address is made');
});

test('per-show settings: a preset from the account, transcripts on or off', async () => {
  let r = await req('GET', `/api/podcasts/${show}/auphonic?presets=1`);
  assert.deepEqual(r.json.presets.map((p: any) => p.name), ['Mono talk', 'Podcast -16 LUFS']);
  assert.equal((await req('PUT', `/api/podcasts/${show}/auphonic`, { enabled: true })).status, 400, 'needs a preset');
  assert.equal((await req('PUT', `/api/podcasts/${show}/auphonic`, { enabled: true, preset: 'nope' })).status, 400);
  r = await req('PUT', `/api/podcasts/${show}/auphonic`, { enabled: true, preset: 'preset-podcast' });
  assert.deepEqual(r.json.settings, { enabled: true, preset: 'preset-podcast', presetName: 'Podcast -16 LUFS', transcripts: true, chapters: 'ours', shownotes: false });
  assert.equal((await req('PUT', `/api/podcasts/${show}/auphonic`, { chapters: 'robots' })).status, 400);
});

test('sending an episode: its metadata, art and chapters go with the preset; Publish waits', async () => {
  original = await upload('raw-episode-12.mp3', mp3(400));
  const art = await upload('ep12.png', PNG);
  let r = await req('POST', `/api/podcasts/${show}/episodes`, {
    title: 'Tomatoes', episode: 12, description: '<p>Staking <b>tomatoes</b> &amp; more.</p>', link: 'https://gardentalk.example.com/12',
    enclosure: { mediaId: original.id }, image: { mediaId: art.id }, status: 'draft',
  });
  assert.equal(r.status, 201, r.text);
  episode = r.json.episode.id;
  await req('PUT', `/api/podcasts/${show}/episodes/${episode}/chapters`, { chapters: [{ startTime: 0, title: 'Intro' }, { startTime: 65.5, title: 'Staking', url: 'https://example.com/stakes' }] });

  r = await req('POST', `/api/podcasts/${show}/episodes/${episode}/process`, { publish: { pubDate: null } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.processing.status, 'processing');
  assert.equal(r.json.processing.publishWhenDone, true);
  const sent = fake.productions[0]!.request;
  assert.equal(sent.preset, 'preset-podcast');
  assert.equal(sent.action, 'start');
  assert.equal(sent.input_file, original.url, 'Auphonic fetches the original from its public address');
  assert.deepEqual(sent.metadata, {
    title: 'Tomatoes', track: 12, artist: 'Johns Creek Studios', album: 'Garden Talk', publisher: 'Randy Black', year: new Date().getFullYear(),
  }, 'only these; summary, genre and the rest come from the preset');
  assert.equal(sent.image, art.url);
  assert.deepEqual(sent.chapters, [{ start: '00:00:00.000', title: 'Intro' }, { start: '00:01:05.500', title: 'Staking', url: 'https://example.com/stakes' }]);
  assert.deepEqual(sent.output_files, [
    { format: 'mp3', bitrate: '128', mono_mixdown: false },
    { format: 'subtitle', ending: 'srt', mono_mixdown: false, split_on_chapters: false },
    { format: 'transcript', ending: 'html', mono_mixdown: false, split_on_chapters: false },
  ], "the preset's output files, with its MP3 replaced by 128 kbps stereo");
  assert.deepEqual(sent.speech_recognition, { language: 'en' });
  assert.equal(sent.webhook, `http://feeds.mine.test/hooks/auphonic/${config.auphonicHookToken}`);

  // Publishing while it processes waits; sending it again is refused.
  r = await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { status: 'published' });
  assert.equal(r.json.episode.status, 'draft');
  assert.equal(r.json.processing.publishWhenDone, true);
  assert.equal((await req('POST', `/api/podcasts/${show}/episodes/${episode}/process`, {})).status, 409);
  assert.doesNotMatch(await feed(), /Tomatoes/);
});

test('when Auphonic calls back: the processed MP3 and four transcripts go in, the original is kept, and it publishes', async () => {
  assert.equal((await req('POST', '/hooks/auphonic/wrong-token-wrong-token-wrong-token-wrong-to', 'uuid=prod1', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 404);
  fake.finish('prod1');
  const hook = await fetch(`${base}/hooks/auphonic/${config.auphonicHookToken}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'uuid=prod1&status=3&status_string=Done' });
  assert.equal(hook.status, 200);
  await waitFor(async () => (await processing()).status === 'done');

  const ep = (await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode;
  assert.equal(ep.inFeed, true, 'published once processing finished');
  assert.notEqual(ep.enclosure.url, original.url);
  assert.match(ep.enclosure.url, /garden-talk-12-tomatoes\.mp3$/);
  assert.ok((await readFile(disk(ep.enclosure.url))).equals(PROCESSED));
  assert.deepEqual(ep.transcripts.map((t: any) => t.type).sort(), ['application/json', 'application/x-subrip', 'text/plain', 'text/vtt']);
  const json = JSON.parse(await readFile(disk(ep.transcripts.find((t: any) => t.type === 'application/json').url), 'utf8'));
  assert.deepEqual(json.segments[1], { startTime: 2.5, endTime: 5, body: 'Today: tomatoes.' });
  const vtt = await readFile(disk(ep.transcripts.find((t: any) => t.type === 'text/vtt').url), 'utf8');
  assert.equal(vtt, 'WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nWelcome to Garden Talk.\n\n00:00:02.500 --> 00:00:05.000\nToday: tomatoes.\n', 'VTT made from the SRT');
  const xml = await feed();
  assert.equal((xml.match(/<podcast:transcript /g) ?? []).length, 4);
  assert.ok(await stat(disk(original.url)), 'the original upload is kept for reprocessing');
});

test('Reprocess sends the kept original again, with the current metadata', async () => {
  await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { title: 'Tomatoes (updated)' });
  const r = await req('POST', `/api/podcasts/${show}/episodes/${episode}/process`, { reprocess: true });
  assert.equal(r.status, 200, r.text);
  const sent = fake.productions[1]!.request;
  assert.equal(sent.input_file, original.url, 'not the already-processed file');
  assert.equal(sent.metadata.title, 'Tomatoes (updated)');
  // A public episode stays public while it's reprocessed.
  assert.equal((await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode.inFeed, true);
  fake.finish('prod2', { error: 'The input file could not be read' });
  await fetch(`${base}/hooks/auphonic/${config.auphonicHookToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: 'prod2' }) });
  await waitFor(async () => (await processing()).status === 'failed');
  assert.match((await processing()).error, /could not be read/);
  assert.equal((await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode.inFeed, true, 'still up with the last good audio');
});

test('Auphonic writes the chapters and show notes when asked; its show notes fill an empty description or wait to be used', async () => {
  // Per episode: Auphonic's chapters and show notes. The editor's chapters aren't sent and are replaced.
  let r = await req('POST', `/api/podcasts/${show}/episodes/${episode}/process`, { reprocess: true, chapters: 'auphonic', shownotes: true });
  assert.equal(r.status, 200, r.text);
  let sent = fake.productions[2]!.request;
  assert.equal(sent.chapters, undefined, 'Auphonic makes the chapters');
  assert.deepEqual(sent.speech_recognition, { language: 'en', shownotes: true });
  fake.finish('prod3', {
    chapters: [{ start: '00:02:00.000', start_output_sec: 120, title: 'Pruning' }, { start: '00:00:04.200', start_output_sec: 4.2, title: 'Welcome' }],
    shownotes: { summaries: { long: ['Randy talks tomatoes.', 'Then pruning & staking.'], brief: ['Tomatoes.'], subtitle: ['Tomato time'] }, tags: ['garden'] },
  });
  await fetch(`${base}/hooks/auphonic/${config.auphonicHookToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: 'prod3' }) });
  await waitFor(async () => (await processing()).status === 'done');
  const ch = (await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters`)).json.chapters;
  assert.deepEqual(ch.map((c: any) => c.title), ['Welcome', 'Pruning']);
  assert.deepEqual(ch.map((c: any) => c.startTime), [0, 120], 'sorted, and the first chapter moved to 00:00:00');
  let p = await processing();
  assert.equal(p.shownotesApplied, false, 'the episode already had show notes, so they wait');
  assert.equal(p.shownotes.long, '<p>Randy talks tomatoes.</p>\n<p>Then pruning &amp; staking.</p>');
  assert.match((await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode.description, /Staking/);
  r = await req('POST', `/api/podcasts/${show}/episodes/${episode}/process/use-shownotes`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.processing.shownotesApplied, true);
  assert.match((await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode.description, /Randy talks tomatoes/);

  // An empty description is filled straight away; chapters from the editor are sent and kept.
  await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { description: '' });
  r = await req('POST', `/api/podcasts/${show}/episodes/${episode}/process`, { reprocess: true, chapters: 'ours', shownotes: true });
  sent = fake.productions[3]!.request;
  assert.deepEqual(sent.chapters.map((c: any) => c.title), ['Welcome', 'Pruning']);
  assert.deepEqual(sent.speech_recognition, { language: 'en', shownotes: true });
  fake.finish('prod4', { chapters: [{ start_output_sec: 5, title: 'Other' }], shownotes: { summaries: { long: 'Fresh notes.' } } });
  await fetch(`${base}/hooks/auphonic/${config.auphonicHookToken}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uuid: 'prod4' }) });
  await waitFor(async () => (await processing()).status === 'done');
  p = await processing();
  assert.equal(p.shownotesApplied, true);
  assert.equal((await req('GET', `/api/podcasts/${show}/episodes/${episode}`)).json.episode.description, '<p>Fresh notes.</p>');
  assert.deepEqual((await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters`)).json.chapters.map((c: any) => c.title), ['Welcome', 'Pruning']);
});

test('SRT to Podcasting 2.0 JSON', () => {
  assert.deepEqual(['en-us', 'pt-BR', 'fr', 'xx-yy', null].map(speechLanguage), ['en', 'pt', 'fr', 'auto', 'auto']);
  assert.equal(srtToText(SRT), 'Welcome to Garden Talk.\nToday: tomatoes.\n');
  assert.equal(vttToSrt('WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n<v Randy>Hi there\n\n01:00:00.000 --> 01:00:01.000\nBye\n'),
    '1\n00:00:01,000 --> 00:00:02,500\nHi there\n\n2\n01:00:00,000 --> 01:00:01,000\nBye\n');
  assert.match(srtToVtt(SRT), /^WEBVTT\n\n00:00:00\.000 --> 00:00:02\.500\nWelcome/);
  assert.deepEqual(JSON.parse(srtToJson(SRT)), { version: '1.0.0', segments: [{ startTime: 0, endTime: 2.5, body: 'Welcome to Garden Talk.' }, { startTime: 2.5, endTime: 5, body: 'Today: tomatoes.' }] });
});
