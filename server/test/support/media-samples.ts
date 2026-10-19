/** Tiny but structurally valid media files for tests. */

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz stereo: 417-byte frames. */
export function mp3(frames: number, opts: { xingFrames?: number; id3?: boolean; v1Tag?: boolean } = {}): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const parts: Buffer[] = [];
  if (opts.id3) {
    const tag = Buffer.alloc(10 + 300);
    tag.write('ID3', 0, 'latin1');
    tag.set([3, 0, 0, 0, 0, 2, 44], 3); // size 300 (syncsafe: 2*128 + 44)
    parts.push(tag);
  }
  for (let i = 0; i < frames; i++) {
    const f = Buffer.from(frame);
    if (i === 0 && opts.xingFrames) {
      f.write('Xing', 36, 'latin1');
      f.writeUInt32BE(1, 40); // frames field present
      f.writeUInt32BE(opts.xingFrames, 44);
    }
    parts.push(f);
  }
  if (opts.v1Tag) {
    const t = Buffer.alloc(128);
    t.write('TAG', 0, 'latin1');
    parts.push(t);
  }
  return Buffer.concat(parts);
}

function box(type: string, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

/** M4A with the moov box after the audio (not "fast start"). */
export function m4a(seconds: number, timescale = 44100): Buffer {
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0isomM4A ', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(2000));
  const mvhd = Buffer.alloc(4 + 16 + 80);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(seconds * timescale, 16);
  return Buffer.concat([ftyp, mdat, box('moov', box('mvhd', mvhd))]);
}

export function wav(seconds: number): Buffer {
  const b = Buffer.alloc(44 + 1000);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + seconds * 176400, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(176400, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(seconds * 176400, 40);
  return b;
}

export function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

export function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
