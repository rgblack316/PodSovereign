import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { parseCues, toLines, parseClock, stripTags } from '../src/chapters-ai/transcript.js';
import { chapterCap, cleanChapters } from '../src/chapters-ai/validate.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { startFakeGemini, type FakeGemini } from './support/fake-gemini.js';
import { startFakePodChapters, type FakePodChapters } from './support/fake-podchapters.js';
import { setupDb, tempDir, testConfig } from './support/env.js';
import { mp3 } from './support/media-samples.js';

const cue = (start: number, text = 'x') => ({ start, text });

describe('transcript lines', () => {
  test('SRT and VTT cues become timestamped lines; text without timings gives none', () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,500\nWelcome.\n\n2\n01:02:03,400 --> 01:02:05,000\n<i>Hello</i>\nthere\n';
    const vtt = 'WEBVTT\n\n00:05.000 --> 00:07.000\nFirst\n\n01:00:00.000 --> 01:00:01.000\nSecond\n';
    assert.equal(toLines(parseCues(srt)), '[00:00:00] Welcome.\n[01:02:03] Hello there');
    assert.equal(toLines(parseCues(vtt)), '[00:00:05] First\n[01:00:00] Second');
    assert.deepEqual(parseCues('Just words with no timings.'), []);
    assert.equal(stripTags('a <b>bold</b> <<b>script>x'), 'a bold x');
    assert.equal(stripTags('<<i>script>alert(1)'), 'alert(1)');
    assert.equal(parseClock('1:02:03'), 3723);
    assert.equal(parseClock('02:03'), 123);
    assert.ok(Number.isNaN(parseClock('soon')));
  });
});

describe('cleaning the AI’s chapters', () => {
  const cues = [0, 20, 61, 100, 130, 200, 400].map((s) => cue(s));
  const base = { durationSec: 450, count: 'moderate' as const, ads: false, links: false, transcriptText: '' };

  test('times snap to real cue starts, sort, drop duplicates and chapters past the end; the first is 0', () => {
    const r = cleanChapters([
      { startTime: '00:03:19', title: 'Late' }, { startTime: '00:00:58', title: 'Middle' }, { startTime: '00:00:02', title: 'Start' },
      { startTime: '00:01:01', title: 'Duplicate of middle' }, { startTime: '02:00:00', title: 'Past the end' },
    ], cues, base);
    assert.deepEqual(r.map((c) => [c.startTime, c.title]), [[0, 'Start'], [61, 'Middle'], [200, 'Late']]);
  });

  test('chapters closer than 30 seconds are merged into the earlier one', () => {
    const r = cleanChapters([{ startTime: '0:00', title: 'A' }, { startTime: '0:20', title: 'B' }, { startTime: '1:40', title: 'C' }, { startTime: '2:10', title: 'D' }], cues, base);
    assert.deepEqual(r.map((c) => c.title), ['A', 'C', 'D']);
  });

  test('titles lose quotes, markup and trailing punctuation, and are trimmed to length', () => {
    const r = cleanChapters([{ startTime: '0:00', title: '  “**Big** <b>news</b> today.”  ' }, { startTime: '1:40', title: 'x '.repeat(80) }], cues, base);
    assert.equal(r[0]!.title, 'Big news today');
    assert.ok(r[1]!.title.length <= 80);
  });

  test('"Ad:" labels are dropped when ad detection is off, kept when on', () => {
    const raw = [{ startTime: '0:00', title: 'Ad: Sponsor' }];
    assert.equal(cleanChapters(raw, cues, base)[0]!.title, 'Sponsor');
    assert.equal(cleanChapters(raw, cues, { ...base, ads: true })[0]!.title, 'Ad: Sponsor');
  });

  test('links are kept only when asked for and spoken in the transcript', () => {
    const raw = [{ startTime: '0:00', title: 'A', url: 'https://real.example.com/x' }, { startTime: '1:40', title: 'B', url: 'https://made-up.example.com' }];
    const on = { ...base, links: true, transcriptText: 'visit https://real.example.com/x today' };
    assert.deepEqual(cleanChapters(raw, cues, on).map((c) => c.url), ['https://real.example.com/x', null]);
    assert.deepEqual(cleanChapters(raw, cues, { ...on, links: false }).map((c) => c.url), [null, null]);
  });

  test('the number of chapters is capped by the choice and the episode length, never over 30', () => {
    assert.ok(chapterCap(3600, 'fewer') < chapterCap(3600, 'moderate'));
    assert.ok(chapterCap(3600, 'moderate') < chapterCap(3600, 'more'));
    assert.equal(chapterCap(10 * 3600, 'more'), 30);
    const many = Array.from({ length: 200 }, (_, i) => cue(i * 60));
    const raw = many.map((c, i) => ({ startTime: String(c.start), title: `Part ${i}` }));
    const r = cleanChapters(raw, many, { ...base, durationSec: 12_000, count: 'fewer' });
    assert.equal(r.length, chapterCap(12_000, 'fewer'));
    assert.equal(r[0]!.startTime, 0);
  });

  test('an empty or unusable answer is refused with a reason', () => {
    assert.throws(() => cleanChapters([], cues, base), /empty/);
    assert.throws(() => cleanChapters([{ startTime: 'later', title: 'x' }], cues, base), /valid startTime/);
  });
});

describe('Gemini chapters through the app', () => {
  let db: Db;
  let server: http.Server;
  let base: string;
  let gem: FakeGemini;
  let pc: FakePodChapters;
  let config: ReturnType<typeof testConfig>;
  let show: string;
  let episode: string;
  let srtMedia: string;
  let cookie = '';
  const SRT = [0, 20, 40, 60].map((s, i) => `${i + 1}\n00:00:${String(s).padStart(2, '0')},000 --> 00:00:${String(s + 10).padStart(2, '0')},000\nLine ${i}. Visit https://tomatoes.example.com now.\n`).join('\n');

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
  const generate = (body: unknown) => req('POST', `/api/podcasts/${show}/episodes/${episode}/chapters/generate`, body);

  before(async () => {
    db = await setupDb('podsovereign_gemini_chapters_test');
    gem = await startFakeGemini('AIza_test_key_12345');
    pc = await startFakePodChapters('pck_test_key_12345');
    config = testConfig({ mediaDir: await tempDir('gemini-media'), publicBaseUrl: 'http://feeds.mine.test', mediaBaseUrl: 'http://feeds.mine.test', geminiUrl: gem.url, podchaptersUrl: pc.url });
    server = http.createServer(createApp({ db, config }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await req('POST', '/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
    show = (await req('POST', '/api/podcasts', { title: 'Tomato Talk', slug: 'tomato-talk' })).json.podcast.id;
    const audio = await upload('tt1.mp3', mp3(3000));
    episode = (await req('POST', `/api/podcasts/${show}/episodes`, { title: 'Tomatoes', enclosure: { mediaId: audio.id }, status: 'draft' })).json.episode.id;
    const srt = await upload('tt1.srt', Buffer.from(SRT));
    srtMedia = srt.id;
    await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { transcripts: [{ mediaId: srt.id, type: 'application/x-subrip', rel: 'captions' }] });
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await gem.close();
    await pc.close();
    await db.close();
  });

  test('the key and model: checked against Gemini, encrypted, never sent back', async () => {
    assert.equal((await req('POST', '/api/admin/site/test-gemini', { key: 'AIza_wrong_key_999', model: 'gemini-test' })).status, 400);
    assert.equal((await req('POST', '/api/admin/site/test-gemini', { key: gem.key, model: 'gemini-nope' })).status, 400);
    assert.equal((await req('POST', '/api/admin/site/test-gemini', { key: gem.key, model: 'gemini-test' })).status, 200);
    const r = await req('PUT', '/api/admin/site', { geminiKey: gem.key, geminiModel: 'gemini-test' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.settings.gemini, { keySet: true, model: 'gemini-test' });
    assert.ok(!r.text.includes(gem.key));
    const row = (await db.query<{ k: string }>(`SELECT gemini_key AS k FROM site_settings WHERE id`)).rows[0]!;
    assert.match(row.k, /^enc:v1:/);
  });

  test('each show picks its chapter makers, and at least one stays on', async () => {
    let r = await req('GET', `/api/podcasts/${show}/podchapters`);
    assert.deepEqual(r.json.providers, { podchapters: true, gemini: false });
    assert.equal(r.json.available.gemini, true);
    assert.equal((await req('PUT', `/api/podcasts/${show}/podchapters`, { providers: { podchapters: false } })).status, 400);
    assert.equal((await generate({ provider: 'gemini' })).status, 409, 'not turned on for this show yet');
    r = await req('PUT', `/api/podcasts/${show}/podchapters`, { providers: { gemini: true } });
    assert.deepEqual(r.json.providers, { podchapters: true, gemini: true });
    const menu = (await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters/generate`)).json;
    assert.deepEqual(menu.providers.map((p: any) => [p.id, p.configured]), [['podchapters', false], ['gemini', true]]);
    assert.deepEqual(menu.options, { style: 'balance', count: 'moderate', ads: false, links: false });
  });

  test('Gemini gets the timed lines and the options; its chapters come back cleaned and unsaved', async () => {
    gem.replies = [JSON.stringify({ chapters: [
      { startTime: '00:00:03', title: '“Intro.”', url: 'https://made-up.example.com' },
      { startTime: '00:00:41', title: 'Ad: Sponsor', url: 'https://tomatoes.example.com' },
    ] })];
    const r = await generate({ provider: 'gemini', options: { style: 'creative', count: 'more', ads: false, links: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.provider, 'gemini');
    assert.equal(r.json.model, 'gemini-test');
    assert.deepEqual(r.json.chapters, [
      { startTime: 0, title: 'Intro', url: null, img: null, toc: true },
      { startTime: 40, title: 'Sponsor', url: 'https://tomatoes.example.com', img: null, toc: true },
    ]);
    const sent = gem.requests.at(-1)!;
    assert.match(sent.body.contents[0].parts[0].text, /^\[00:00:00\] Line 0\./);
    assert.match(sent.body.systemInstruction.parts[0].text, /catchy titles/);
    assert.match(sent.body.systemInstruction.parts[0].text, /every 2 to 3 minutes/);
    assert.match(sent.body.systemInstruction.parts[0].text, /web address is spoken/);
    assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
    const saved = (await req('GET', `/api/podcasts/${show}/episodes/${episode}/chapters`)).json.chapters;
    assert.ok(!saved?.length, 'nothing is saved until the editor saves');
  });

  test('an unusable answer is asked for again once, with the problem; then it gives up with a message', async () => {
    const before = gem.requests.length;
    gem.replies = ['not json', JSON.stringify({ chapters: [{ startTime: '0:00', title: 'Fine' }] })];
    let r = await generate({ provider: 'gemini' });
    assert.equal(r.status, 200, r.text);
    assert.equal(gem.requests.length - before, 2);
    assert.match(gem.requests.at(-1)!.body.contents[0].parts[0].text, /could not be used/);
    gem.replies = ['{"chapters":[]}'];
    r = await generate({ provider: 'gemini' });
    assert.equal(r.status, 424);
    assert.match(r.json.error, /usable chapters/);
  });

  test('Gemini errors say what happened, and a transcript without timings is refused', async () => {
    gem.failNext = 429;
    let r = await generate({ provider: 'gemini' });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /too many requests|quota/);
    const txt = await upload('tt1.txt', Buffer.from('Only words, no timings.'));
    await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { transcripts: [{ mediaId: srtMedia, type: 'application/x-subrip', rel: 'captions' }, { mediaId: txt.id, type: 'text/plain' }] });
    // SRT is still preferred, so Gemini keeps working.
    gem.replies = [JSON.stringify({ chapters: [{ startTime: '0:00', title: 'Fine' }] })];
    r = await generate({ provider: 'gemini' });
    assert.equal(r.status, 200, r.text);
    // With only the plain text left there are no timings to work from.
    await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { transcripts: [{ mediaId: txt.id, type: 'text/plain' }] });
    r = await generate({ provider: 'gemini' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /no timings/);
    await req('PATCH', `/api/podcasts/${show}/episodes/${episode}`, { transcripts: [{ mediaId: srtMedia, type: 'application/x-subrip', rel: 'captions' }] });
  });

  test('PodChapters still works on the same request, with the options from the request', async () => {
    await req('PUT', '/api/admin/site', { podchaptersKey: pc.key });
    pc.chapters = [{ start: 4, title: 'Welcome' }];
    const r = await generate({ provider: 'podchapters', options: { style: 'strict', count: 'fewer', ads: true, links: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.provider, 'podchapters');
    assert.equal(r.json.chapters[0].startTime, 0);
    const sent = [...pc.episodes.values()][0]!;
    assert.ok(sent);
    assert.equal((await generate({ provider: 'nope' })).status, 400);
    assert.equal((await generate({ provider: 'gemini', options: { count: 'lots' } })).status, 400);
  });
});
