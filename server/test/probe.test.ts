import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { before, test } from 'node:test';
import { probeFile } from '../src/media/probe.js';
import { cleanFilename } from '../src/media/uploads.js';
import { jpeg, m4a, mp3, png, wav } from './support/media-samples.js';
import { tempDir } from './support/env.js';

let dir: string;
before(async () => {
  dir = await tempDir('probe');
});

async function probe(name: string, body: Buffer, mime: string) {
  const f = path.join(dir, name);
  await writeFile(f, body);
  return probeFile(f, mime);
}

test('constant-bitrate MP3: length from size and bitrate, skipping ID3 tags', async () => {
  // 1000 frames × 1152 samples ÷ 44100 Hz ≈ 26.1 s
  assert.deepEqual(await probe('cbr.mp3', mp3(1000, { id3: true, v1Tag: true }), 'audio/mpeg'), { duration: 26 });
});

test('VBR MP3: length from the Xing header frame count', async () => {
  // 100000 × 1152 ÷ 44100 = 2612.2 s
  assert.deepEqual(await probe('vbr.mp3', mp3(5, { xingFrames: 100_000 }), 'audio/mpeg'), { duration: 2612 });
});

test('M4A with moov at the end: length from mvhd', async () => {
  assert.deepEqual(await probe('ep.m4a', m4a(3723), 'audio/x-m4a'), { duration: 3723 });
});

test('WAV: length from the data size and byte rate', async () => {
  assert.deepEqual(await probe('ep.wav', wav(95), 'audio/wav'), { duration: 95 });
});

test('images: PNG and JPEG sizes', async () => {
  assert.deepEqual(await probe('art.png', png(3000, 3000), 'image/png'), { width: 3000, height: 3000 });
  assert.deepEqual(await probe('art.jpg', jpeg(1400, 1200), 'image/jpeg'), { width: 1400, height: 1200 });
});

test('unknown or garbage files give nothing rather than a wrong answer', async () => {
  assert.deepEqual(await probe('noise.mp3', Buffer.from('not audio at all'), 'audio/mpeg'), {});
  assert.deepEqual(await probe('empty.m4a', Buffer.alloc(0), 'audio/x-m4a'), {});
});

test('uploaded file names are made safe', () => {
  assert.equal(cleanFilename('../../etc/passwd'), 'passwd');
  assert.equal(cleanFilename('Épisode 12: the “big” one!.MP3'), 'Episode-12-the-big-one.mp3');
  assert.equal(cleanFilename('C:\\Users\\me\\show art.PNG'), 'show-art.png');
  assert.equal(cleanFilename('.mp3'), 'file.mp3');
});
