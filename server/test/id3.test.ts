import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { readId3Chapters, readTag, writeId3Chapters, type Id3Chapter } from '../src/media/id3.js';
import { probeFile } from '../src/media/probe.js';
import { tempDir } from './support/env.js';
import { mp3 } from './support/media-samples.js';

let dir: string;
before(async () => {
  dir = await tempDir('id3');
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082', 'hex');

/** A hand-built ID3 tag, for files "from another app". */
function tag(version: 3 | 4, frames: Buffer[], unsync = false): Buffer {
  let body = Buffer.concat(frames);
  if (unsync) {
    const out: number[] = [];
    for (const b of body) { out.push(b); if (b === 0xff) out.push(0); }
    body = Buffer.from(out);
  }
  const h = Buffer.alloc(10);
  h.write('ID3', 0, 'latin1');
  h[3] = version;
  h[5] = unsync ? 0x80 : 0;
  const n = body.length;
  h.set([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f], 6);
  return Buffer.concat([h, body]);
}
function fr(version: 3 | 4, id: string, body: Buffer) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  if (version === 4) h.set([(body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f, (body.length >> 7) & 0x7f, body.length & 0x7f], 4);
  else h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}
const times = (s: number, e: number) => { const b = Buffer.alloc(16, 0xff); b.writeUInt32BE(s, 0); b.writeUInt32BE(e, 4); return b; };

test('reads chapters written by other apps (v2.3 UTF-16, v2.4 UTF-8, with links, images and a hidden marker)', async () => {
  const v3 = tag(3, [
    fr(3, 'TIT2', Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from('Episode 12', 'utf16le')])),
    fr(3, 'CTOC', Buffer.concat([Buffer.from('toc\0', 'latin1'), Buffer.from([3, 2]), Buffer.from('c1\0c2\0', 'latin1')])),
    fr(3, 'CHAP', Buffer.concat([Buffer.from('c2\0', 'latin1'), times(65_500, 120_000),
      fr(3, 'TIT2', Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from('Café talk ☕', 'utf16le')])),
      fr(3, 'WXXX', Buffer.concat([Buffer.from([0, 0]), Buffer.from('https://example.com/cafe', 'latin1')])),
      fr(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3, 0]), PNG]))])),
    fr(3, 'CHAP', Buffer.concat([Buffer.from('c1\0', 'latin1'), times(0, 65_500), fr(3, 'TIT2', Buffer.concat([Buffer.from([0]), Buffer.from('Intro', 'latin1')]))])),
    fr(3, 'CHAP', Buffer.concat([Buffer.from('ad\0', 'latin1'), times(30_000, 31_000), fr(3, 'TIT2', Buffer.concat([Buffer.from([0]), Buffer.from('Ad break', 'latin1')]))])),
  ], true);
  const f = path.join(dir, 'v3.mp3');
  await writeFile(f, Buffer.concat([v3, mp3(40)]));
  const ch = await readId3Chapters(f);
  assert.deepEqual(ch.map((c) => [c.startTime, c.title, c.toc]), [[0, 'Intro', true], [30, 'Ad break', false], [65.5, 'Café talk ☕', true]]);
  assert.equal(ch[2]!.url, 'https://example.com/cafe');
  assert.equal(ch[2]!.image!.mime, 'image/png');
  assert.ok(ch[2]!.image!.data.equals(PNG), 'image survives unsynchronisation');

  const v4 = tag(4, [fr(4, 'CHAP', Buffer.concat([Buffer.from('a\0', 'latin1'), times(5000, 9000), fr(4, 'TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('Über alles', 'utf8')]))]))]);
  const f4 = path.join(dir, 'v4.mp3');
  await writeFile(f4, Buffer.concat([v4, mp3(10)]));
  assert.deepEqual((await readId3Chapters(f4)).map((c) => [c.startTime, c.endTime, c.title]), [[5, 9, 'Über alles']]);

  const none = path.join(dir, 'none.mp3');
  await writeFile(none, mp3(10, { id3: true }));
  assert.deepEqual(await readId3Chapters(none), []);
});

test('writing replaces only the chapters: other tags and the audio stay byte for byte', async () => {
  const audio = mp3(200);
  const art = fr(3, 'APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0', 'latin1'), Buffer.from([3, 0]), PNG]));
  const title = fr(3, 'TIT2', Buffer.concat([Buffer.from([0]), Buffer.from('My episode', 'latin1')]));
  const oldChap = fr(3, 'CHAP', Buffer.concat([Buffer.from('old\0', 'latin1'), times(0, 1000), fr(3, 'TIT2', Buffer.concat([Buffer.from([0]), Buffer.from('Old', 'latin1')]))]));
  const src = path.join(dir, 'src.mp3');
  await writeFile(src, Buffer.concat([tag(3, [title, art, oldChap]), audio]));

  const chapters: Id3Chapter[] = [
    { startTime: 0, endTime: null, title: 'Welcome', url: null, image: null, toc: true },
    { startTime: 2.5, endTime: null, title: 'Interview with Ana María', url: 'https://example.com/ana', image: { mime: 'image/png', data: PNG }, toc: true },
    { startTime: 4, endTime: null, title: 'Sponsor', url: null, image: null, toc: false },
  ];
  const out = path.join(dir, 'out.mp3');
  await writeId3Chapters(src, out, chapters, 5.2);
  const back = await readId3Chapters(out);
  assert.deepEqual(back.map((c) => [c.startTime, c.endTime, c.title, c.url, c.toc]), [
    [0, 2.5, 'Welcome', null, true],
    [2.5, 4, 'Interview with Ana María', 'https://example.com/ana', true],
    [4, 5.2, 'Sponsor', null, false],
  ]);
  assert.ok(back[1]!.image!.data.equals(PNG));
  const t = (await readTag(out))!;
  assert.deepEqual(t.frames.map((f) => f.id), ['TIT2', 'APIC', 'CTOC', 'CHAP', 'CHAP', 'CHAP'], 'other frames kept, old chapters replaced');
  assert.ok(t.frames[1]!.raw.equals(art), 'cover art untouched');
  const bytes = await readFile(out);
  assert.ok(bytes.subarray(t.length).equals(audio), 'audio untouched');
  const probe = await probeFile(out, 'audio/mpeg');
  assert.ok(Math.abs((probe.duration ?? 0) - (await probeFile(src, 'audio/mpeg')).duration!) < 1, 'still plays the same length');

  // An empty list removes them; a file with no tag gets one.
  const cleared = path.join(dir, 'cleared.mp3');
  await writeId3Chapters(out, cleared, [], null);
  assert.deepEqual(await readId3Chapters(cleared), []);
  assert.deepEqual((await readTag(cleared))!.frames.map((f) => f.id), ['TIT2', 'APIC']);
  const bare = path.join(dir, 'bare.mp3');
  await writeFile(bare, audio);
  const tagged = path.join(dir, 'tagged.mp3');
  await writeId3Chapters(bare, tagged, chapters.slice(0, 1), 5);
  assert.equal((await readId3Chapters(tagged))[0]!.title, 'Welcome');
  assert.ok((await readFile(tagged)).subarray((await readTag(tagged))!.length).equals(audio));
});
