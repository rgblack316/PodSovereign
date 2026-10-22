/**
 * MP3 chapters in ID3v2 tags (the "ID3v2 Chapter Frame Addendum"):
 * CHAP frames (one per chapter: start/end time, then sub-frames TIT2 title,
 * WXXX link, APIC image) and a CTOC frame listing them in order.
 * Hindenburg, Forecast, Ferrite, Auphonic and others write these; Apple
 * Podcasts and other apps read them.
 *
 * readId3Chapters() reads them; writeId3Chapters() replaces them in a copy of
 * the file, keeping every other tag (title, artist, artwork…) and the audio
 * itself byte for byte.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export interface Id3Chapter {
  /** Seconds. */
  startTime: number;
  endTime: number | null;
  title: string;
  url: string | null;
  image: { mime: string; data: Buffer } | null;
  /** Listed in the table of contents (false = a hidden marker). */
  toc: boolean;
}

const syncsafe = (b: Buffer, i: number) => ((b[i]! & 0x7f) << 21) | ((b[i + 1]! & 0x7f) << 14) | ((b[i + 2]! & 0x7f) << 7) | (b[i + 3]! & 0x7f);
const toSyncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);

/** Undo ID3 "unsynchronisation" (0xFF 0x00 → 0xFF). */
function deunsync(b: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]!);
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return Buffer.from(out);
}

interface Tag {
  version: number; // 3 or 4
  /** Frames as raw bytes (header + body), in order. */
  frames: { id: string; raw: Buffer; body: Buffer }[];
  /** Bytes the whole tag takes at the start of the file (incl. header and footer). */
  length: number;
}

/** Read the ID3v2 tag at the start of a file, or null when there isn't one (or it's a version we don't handle). */
export async function readTag(file: string): Promise<Tag | null> {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(10);
    const { bytesRead } = await fh.read(head, 0, 10, 0);
    if (bytesRead < 10 || head.toString('latin1', 0, 3) !== 'ID3') return null;
    const version = head[3]!;
    const flags = head[5]!;
    const size = syncsafe(head, 6);
    const length = 10 + size + (flags & 0x10 ? 10 : 0);
    if (version !== 3 && version !== 4) return { version, frames: [], length };
    let body: Buffer = Buffer.alloc(size);
    await fh.read(body, 0, size, 10);
    if (flags & 0x80 && version === 3) body = deunsync(body);
    return { version, frames: parseFrames(body, version, flags), length };
  } finally {
    await fh.close();
  }
}

function parseFrames(body: Buffer, version: number, tagFlags: number): Tag['frames'] {
  let i = 0;
  if (tagFlags & 0x40) {
    // Extended header: skip it.
    i = version === 4 ? syncsafe(body, 0) : body.readUInt32BE(0) + 4;
  }
  const frames: Tag['frames'] = [];
  while (i + 10 <= body.length) {
    const id = body.toString('latin1', i, i + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
    const size = version === 4 ? syncsafe(body, i + 4) : body.readUInt32BE(i + 4);
    if (size < 0 || i + 10 + size > body.length) break;
    frames.push({ id, raw: body.subarray(i, i + 10 + size), body: body.subarray(i + 10, i + 10 + size) });
    i += 10 + size;
  }
  return frames;
}

// ───────────── reading ─────────────

const TERMS = [Buffer.from([0]), Buffer.from([0, 0])];
/** Split off a null-terminated string in the given text encoding; returns [text, rest]. */
function cstring(b: Buffer, enc: number): [string, Buffer] {
  const wide = enc === 1 || enc === 2;
  let end = -1;
  if (wide) {
    for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) { end = i; break; }
  } else end = b.indexOf(TERMS[0]!);
  const raw = end < 0 ? b : b.subarray(0, end);
  const rest = end < 0 ? Buffer.alloc(0) : b.subarray(end + (wide ? 2 : 1));
  return [decode(raw, enc), rest];
}

function decode(b: Buffer, enc: number): string {
  if (enc === 0) return b.toString('latin1');
  if (enc === 3) return b.toString('utf8');
  if (enc === 1) {
    // UTF-16 with a byte-order mark.
    if (b[0] === 0xfe && b[1] === 0xff) return swap16(b.subarray(2)).toString('utf16le');
    if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
    return b.toString('utf16le');
  }
  if (enc === 2) return swap16(b).toString('utf16le'); // UTF-16BE without BOM
  return b.toString('latin1');
}

function swap16(b: Buffer): Buffer {
  const c = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
  c.swap16();
  return c;
}

const textFrame = (body: Buffer) => (body.length ? cstring(body.subarray(1), body[0]!)[0].replace(/\0+$/, '').trim() : '');

/** Chapters in an MP3's ID3 tag, in table-of-contents order (or by start time). Empty when there are none. */
export async function readId3Chapters(file: string): Promise<Id3Chapter[]> {
  const tag = await readTag(file);
  if (!tag || !tag.frames.length) return [];
  const byId = new Map<string, Id3Chapter>();
  const order: string[] = [];
  let tocIds: string[] | null = null;
  for (const f of tag.frames) {
    if (f.id === 'CHAP') {
      const [elementId, rest] = cstring(f.body, 0);
      if (rest.length < 16) continue;
      const start = rest.readUInt32BE(0);
      const end = rest.readUInt32BE(4);
      const ch: Id3Chapter = { startTime: start / 1000, endTime: end && end !== 0xffffffff ? end / 1000 : null, title: '', url: null, image: null, toc: true };
      for (const s of parseFrames(rest.subarray(16), tag.version, 0)) {
        if (s.id === 'TIT2') ch.title = textFrame(s.body);
        else if (s.id === 'WXXX' && s.body.length) {
          const [, urlPart] = cstring(s.body.subarray(1), s.body[0]!);
          const url = urlPart.toString('latin1').replace(/\0+$/, '').trim();
          if (/^https?:\/\//i.test(url)) ch.url = url;
        } else if (s.id === 'APIC' && s.body.length > 4) {
          const enc = s.body[0]!;
          const [mime, afterMime] = cstring(s.body.subarray(1), 0);
          const [, data] = cstring(afterMime.subarray(1), enc); // picture type byte, then description
          const type = /^image\/(jpeg|jpg|png|webp)$/i.test(mime) ? mime.toLowerCase().replace('jpg', 'jpeg') : sniffImage(data);
          if (type && data.length) ch.image = { mime: type, data: Buffer.from(data) };
        }
      }
      byId.set(elementId, ch);
      order.push(elementId);
    } else if (f.id === 'CTOC' && tocIds === null) {
      const [, rest] = cstring(f.body, 0);
      if (rest.length < 2) continue;
      const flags = rest[0]!;
      const count = rest[1]!;
      if (!(flags & 0x02) && tocIds !== null) continue; // only the top-level table
      let r = rest.subarray(2);
      const ids: string[] = [];
      for (let n = 0; n < count && r.length; n++) {
        const [id, next] = cstring(r, 0);
        ids.push(id);
        r = next;
      }
      tocIds = ids;
    }
  }
  const all = order.map((id) => byId.get(id)!);
  if (tocIds) {
    const listed = new Set(tocIds);
    for (const [id, ch] of byId) ch.toc = listed.has(id);
  }
  return all.sort((a, b) => a.startTime - b.startTime).map((c, i) => ({ ...c, title: c.title || `Chapter ${i + 1}` }));
}

function sniffImage(b: Buffer): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ───────────── writing ─────────────

function frame(id: string, body: Buffer, version: number): Buffer {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  if (version === 4) toSyncsafe(body.length).copy(h, 4);
  else h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

/** Text in the tag's preferred encoding: UTF-16 with BOM for v2.3, UTF-8 for v2.4. */
function encodeText(s: string, version: number): Buffer {
  if (version === 4) return Buffer.concat([Buffer.from([3]), Buffer.from(s, 'utf8')]);
  if (/^[\x20-\x7e]*$/.test(s)) return Buffer.concat([Buffer.from([0]), Buffer.from(s, 'latin1')]);
  return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}

function chapterFrames(chapters: Id3Chapter[], durationSec: number | null, version: number): Buffer[] {
  const ms = (s: number) => Math.max(0, Math.round(s * 1000));
  const sorted = [...chapters].sort((a, b) => a.startTime - b.startTime);
  const ids = sorted.map((_, i) => `chp${i}`);
  const chaps = sorted.map((c, i) => {
    const end = c.endTime ?? sorted[i + 1]?.startTime ?? durationSec ?? c.startTime;
    const times = Buffer.alloc(16);
    times.writeUInt32BE(ms(c.startTime), 0);
    times.writeUInt32BE(Math.max(ms(end), ms(c.startTime)), 4);
    times.writeUInt32BE(0xffffffff, 8);
    times.writeUInt32BE(0xffffffff, 12);
    const subs = [frame('TIT2', encodeText(c.title, version), version)];
    if (c.url) subs.push(frame('WXXX', Buffer.concat([Buffer.from([0, 0]), Buffer.from(c.url, 'latin1')]), version));
    if (c.image) {
      subs.push(frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from(`${c.image.mime}\0`, 'latin1'), Buffer.from([0, 0]), c.image.data]), version));
    }
    return frame('CHAP', Buffer.concat([Buffer.from(`${ids[i]}\0`, 'latin1'), times, ...subs]), version);
  });
  const listed = sorted.map((c, i) => (c.toc ? ids[i]! : null)).filter((x): x is string => !!x);
  const ctoc = frame('CTOC', Buffer.concat([
    Buffer.from('toc\0', 'latin1'),
    Buffer.from([0x03, listed.length]), // top level, ordered
    ...listed.map((id) => Buffer.from(`${id}\0`, 'latin1')),
  ]), version);
  return [ctoc, ...chaps];
}

/**
 * Copy `src` to `dest` with its chapters replaced (an empty list removes
 * them). Every other tag frame and the audio are kept as they are.
 */
export async function writeId3Chapters(src: string, dest: string, chapters: Id3Chapter[], durationSec: number | null): Promise<void> {
  if (chapters.length > 255) throw new Error('An MP3 can hold at most 255 chapters in its table of contents');
  const tag = await readTag(src);
  const usable = tag && (tag.version === 3 || tag.version === 4);
  const version = usable ? tag!.version : 3;
  const kept = usable ? tag!.frames.filter((f) => f.id !== 'CHAP' && f.id !== 'CTOC').map((f) => f.raw) : [];
  const frames = Buffer.concat([...kept, ...(chapters.length ? chapterFrames(chapters, durationSec, version) : [])]);
  const padding = Buffer.alloc(1024);
  const body = Buffer.concat([frames, padding]);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = version;
  header[4] = 0;
  header[5] = 0; // no unsynchronisation, extended header or footer
  toSyncsafe(body.length).copy(header, 6);
  const audioStart = tag ? tag.length : 0;
  const out = createWriteStream(dest);
  await new Promise<void>((resolve, reject) => {
    out.write(Buffer.concat([header, body]), (e) => (e ? reject(e) : resolve()));
  });
  await pipeline(createReadStream(src, { start: audioStart }), out);
}
