/**
 * Reads what a podcast feed needs from an uploaded file without external tools:
 * the running time of audio and video (for <itunes:duration>) and the size of
 * images (Apple wants square show art, 1400–3000 px).
 *
 * Supported: MP3 (Xing/Info/VBRI headers, or constant bitrate), MP4/M4A/MOV,
 * WAV, Ogg Opus; PNG, JPEG, WebP. Anything else returns {} and the podcaster
 * types the length in.
 */
import { open, type FileHandle } from 'node:fs/promises';

export interface ProbeResult {
  /** Seconds, rounded. */
  duration?: number;
  width?: number;
  height?: number;
}

export async function probeFile(file: string, mimeType: string): Promise<ProbeResult> {
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const head = await readAt(fh, 0, Math.min(size, 256 * 1024));
    const t = mimeType.toLowerCase();
    let r: ProbeResult | null = null;
    if (head.subarray(0, 8).equals(PNG_SIG)) r = pngSize(head);
    else if (head[0] === 0xff && head[1] === 0xd8) r = jpegSize(head);
    else if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') r = webpSize(head);
    else if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') r = wavDuration(head);
    else if (ascii(head, 4, 4) === 'ftyp') r = await mp4Duration(fh, size);
    else if (ascii(head, 0, 4) === 'OggS') r = await opusDuration(fh, size, head);
    else if (ascii(head, 0, 3) === 'ID3' || t === 'audio/mpeg' || t === 'audio/mp3') r = await mp3Duration(fh, size);
    return clean(r ?? {});
  } catch {
    return {};
  } finally {
    await fh.close();
  }
}

function clean(r: ProbeResult): ProbeResult {
  const out: ProbeResult = {};
  if (r.duration !== undefined && Number.isFinite(r.duration) && r.duration > 0 && r.duration < 100 * 3600) out.duration = Math.round(r.duration);
  if (r.width && r.height && r.width < 100_000 && r.height < 100_000) {
    out.width = r.width;
    out.height = r.height;
  }
  return out;
}

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, len));
  const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
  return buf.subarray(0, bytesRead);
}

const ascii = (b: Buffer, at: number, len: number) => (b.length >= at + len ? b.toString('latin1', at, at + len) : '');

// ───────────── images ─────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(b: Buffer): ProbeResult | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): ProbeResult | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // Start-of-frame markers carry the size (C4 = DHT, C8 = JPG, CC = DAC are not frames).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): ProbeResult | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const v = b.readUInt32LE(21);
    return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// ───────────── WAV ─────────────

function wavDuration(b: Buffer): ProbeResult | null {
  let i = 12;
  let byteRate = 0;
  while (i + 8 <= b.length) {
    const id = ascii(b, i, 4);
    const len = b.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 16 <= b.length) byteRate = b.readUInt32LE(i + 16);
    if (id === 'data') return byteRate ? { duration: len / byteRate } : null;
    i += 8 + len + (len & 1);
  }
  return null;
}

// ───────────── MP4 / M4A / MOV ─────────────

/** Walks top-level boxes to moov → mvhd. moov may sit after the audio (not "fast start"). */
async function mp4Duration(fh: FileHandle, size: number): Promise<ProbeResult | null> {
  let pos = 0;
  while (pos + 8 <= size) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) return null;
    let boxSize = h.readUInt32BE(0);
    const type = ascii(h, 4, 4);
    let headerLen = 8;
    if (boxSize === 1) {
      boxSize = Number(h.readBigUInt64BE(8));
      headerLen = 16;
    } else if (boxSize === 0) boxSize = size - pos;
    if (boxSize < headerLen) return null;
    if (type === 'moov') {
      const moov = await readAt(fh, pos + headerLen, Math.min(boxSize - headerLen, 64 * 1024 * 1024));
      return mvhd(moov);
    }
    pos += boxSize;
  }
  return null;
}

function mvhd(moov: Buffer): ProbeResult | null {
  let i = 0;
  while (i + 8 <= moov.length) {
    const len = moov.readUInt32BE(i);
    if (ascii(moov, i + 4, 4) === 'mvhd') {
      const v = moov[i + 8];
      const d = i + 12; // after size, type, version, flags
      if (v === 1 && d + 28 <= moov.length) {
        const scale = moov.readUInt32BE(d + 16);
        return scale ? { duration: Number(moov.readBigUInt64BE(d + 20)) / scale } : null;
      }
      if (d + 16 <= moov.length) {
        const scale = moov.readUInt32BE(d + 8);
        return scale ? { duration: moov.readUInt32BE(d + 12) / scale } : null;
      }
      return null;
    }
    if (len < 8) return null;
    i += len;
  }
  return null;
}

// ───────────── Ogg Opus ─────────────

/** Opus always counts samples at 48 kHz: the last page's granule position (minus pre-skip) is the length. */
async function opusDuration(fh: FileHandle, size: number, head: Buffer): Promise<ProbeResult | null> {
  const id = head.indexOf('OpusHead', 0, 'latin1');
  if (id < 0 || id + 12 > head.length) return null;
  const preSkip = head.readUInt16LE(id + 10);
  const tailLen = Math.min(size, 128 * 1024);
  const tail = await readAt(fh, size - tailLen, tailLen);
  const last = tail.lastIndexOf('OggS', tail.length - 1, 'latin1');
  if (last < 0 || last + 14 > tail.length) return null;
  const granule = Number(tail.readBigUInt64LE(last + 6));
  return { duration: (granule - preSkip) / 48000 };
}

// ───────────── MP3 ─────────────

const BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Frame {
  version: number; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  layer: number; // 1, 2, 3
  bitrate: number; // bits per second
  sampleRate: number;
  mono: boolean;
  length: number; // bytes
  samples: number; // per frame
}

export function mp3Frame(b: Buffer, i: number): Frame | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1]! >> 3) & 3;
  const layerBits = (b[i + 1]! >> 1) & 3;
  const brIndex = b[i + 2]! >> 4;
  const srIndex = (b[i + 2]! >> 2) & 3;
  const padding = (b[i + 2]! >> 1) & 1;
  if (version === 1 || layerBits === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const layer = 4 - layerBits;
  const v1 = version === 3;
  const table = v1 ? (layer === 1 ? BITRATES.v1l1 : layer === 2 ? BITRATES.v1l2 : BITRATES.v1l3) : layer === 1 ? BITRATES.v2l1 : BITRATES.v2l23;
  const bitrate = table[brIndex]! * 1000;
  const sampleRate = SAMPLE_RATES[version]![srIndex]!;
  const samples = layer === 1 ? 384 : layer === 2 || v1 ? 1152 : 576;
  const length = layer === 1
    ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
    : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return { version, layer, bitrate, sampleRate, mono: (b[i + 3]! >> 6) === 3, length, samples };
}

async function mp3Duration(fh: FileHandle, size: number): Promise<ProbeResult | null> {
  let start = 0;
  // Skip any ID3v2 tags (sizes are "syncsafe": 7 bits per byte).
  for (let n = 0; n < 4; n++) {
    const t = await readAt(fh, start, 10);
    if (ascii(t, 0, 3) !== 'ID3' || t.length < 10) break;
    const len = ((t[6]! & 0x7f) << 21) | ((t[7]! & 0x7f) << 14) | ((t[8]! & 0x7f) << 7) | (t[9]! & 0x7f);
    start += 10 + len + (t[5]! & 0x10 ? 10 : 0);
  }
  const buf = await readAt(fh, start, 64 * 1024);

  // First real frame: one whose next frame also lines up (rules out stray 0xFF bytes).
  let at = -1;
  let frame: Frame | null = null;
  for (let i = 0; i + 4 <= buf.length; i++) {
    const f = mp3Frame(buf, i);
    if (!f) continue;
    const next = i + f.length;
    if (next + 4 <= buf.length && !mp3Frame(buf, next)) continue;
    at = i;
    frame = f;
    break;
  }
  if (!frame) return null;

  // Xing / Info header (VBR, and LAME's CBR "Info").
  const side = frame.version === 3 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const x = at + 4 + side;
  const tag = ascii(buf, x, 4);
  if ((tag === 'Xing' || tag === 'Info') && x + 12 <= buf.length && buf.readUInt32BE(x + 4) & 1) {
    const frames = buf.readUInt32BE(x + 8);
    if (frames) return { duration: (frames * frame.samples) / frame.sampleRate };
  }
  // VBRI header (Fraunhofer encoders), always 32 bytes after the frame header.
  if (ascii(buf, at + 36, 4) === 'VBRI' && at + 54 <= buf.length) {
    const frames = buf.readUInt32BE(at + 50);
    if (frames) return { duration: (frames * frame.samples) / frame.sampleRate };
  }
  // Constant bitrate: audio bytes ÷ bitrate.
  const tail = await readAt(fh, Math.max(0, size - 128), Math.min(128, size));
  const audioBytes = size - start - at - (ascii(tail, 0, 3) === 'TAG' ? 128 : 0);
  return { duration: (audioBytes * 8) / frame.bitrate };
}
