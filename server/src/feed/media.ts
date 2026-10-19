import type { Feed, XmlNode } from './types.js';

export type MediaKind = 'audio' | 'video' | 'image' | 'transcript' | 'chapters' | 'other';

export interface MediaRef {
  kind: MediaKind;
  url: string;
  /** Human-readable location, e.g. 'item[3] enclosure'. */
  where: string;
  /** Point this reference at a new URL (after the file is copied to our server). */
  set(url: string): void;
}

/** Attributes inside `extra` tags that reference downloadable files. */
const EXTRA_REFS: Record<string, { attr: string; kind: MediaKind }> = {
  'podcast:transcript': { attr: 'url', kind: 'transcript' },
  'podcast:chapters': { attr: 'url', kind: 'chapters' },
  'podcast:person': { attr: 'img', kind: 'image' },
  'podcast:image': { attr: 'href', kind: 'image' },
  'podcast:source': { attr: 'uri', kind: 'other' },
  'podcast:trailer': { attr: 'url', kind: 'audio' },
};

/** Live streams and links to other feeds must never be downloaded. */
const SKIP_SUBTREES = new Set(['podcast:liveItem', 'podcast:remoteItem', 'podcast:podroll']);

const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);

/** Every file the feed references, for the import worker to copy. */
export function collectMediaRefs(feed: Feed): MediaRef[] {
  const refs: MediaRef[] = [];
  const c = feed.channel;

  if (isHttp(c.imageUrl)) refs.push({ kind: 'image', url: c.imageUrl, where: 'channel image', set: (u) => (c.imageUrl = u) });
  htmlImageRefs(() => c.description, (v) => (c.description = v), 'channel description', refs);
  walkExtra(c.extra, 'channel', refs);

  feed.items.forEach((it, i) => {
    const at = `item[${i}]`;
    if (isHttp(it.enclosureUrl)) {
      const kind: MediaKind = it.enclosureType?.startsWith('video/') ? 'video' : 'audio';
      refs.push({ kind, url: it.enclosureUrl, where: `${at} enclosure`, set: (u) => (it.enclosureUrl = u) });
    }
    if (isHttp(it.itunesImageUrl)) {
      refs.push({ kind: 'image', url: it.itunesImageUrl, where: `${at} image`, set: (u) => (it.itunesImageUrl = u) });
    }
    htmlImageRefs(() => it.description, (v) => (it.description = v), `${at} show notes`, refs);
    walkExtra(it.extra, at, refs);
  });
  return refs;
}

/** podcast:images srcset="url 1500w, url 600w" — one ref per URL. */
function collectSrcset(n: XmlNode, where: string, refs: MediaRef[]): void {
  const entries = (n.attrs.srcset ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  entries.forEach((entry, i) => {
    const [url, ...desc] = entry.split(/\s+/);
    if (!isHttp(url)) return;
    refs.push({
      kind: 'image',
      url,
      where: `${where} podcast:images`,
      set: (u) => {
        const parts = (n.attrs.srcset ?? '').split(',').map((e) => e.trim()).filter(Boolean);
        parts[i] = [u, ...desc].join(' ');
        n.attrs.srcset = parts.join(', ');
      },
    });
  });
}

function walkExtra(nodes: XmlNode[], where: string, refs: MediaRef[], parent?: XmlNode): void {
  for (const n of nodes) {
    if (SKIP_SUBTREES.has(n.name)) continue;
    if (n.name === 'podcast:images' && n.attrs.srcset) collectSrcset(n, where, refs);
    if (HTML_TEXT_TAGS.has(n.name) && n.text) {
      htmlImageRefs(() => n.text, (v) => (n.text = v), `${where} ${n.name}`, refs);
    }
    const spec = EXTRA_REFS[n.name];
    const url = spec ? n.attrs[spec.attr] : undefined;
    if (spec && isHttp(url)) {
      let kind = spec.kind;
      if (n.name === 'podcast:source') {
        const type = parent?.attrs.type ?? n.attrs.contentType ?? '';
        kind = type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'other';
      }
      refs.push({ kind, url, where: `${where} ${n.name}`, set: (u) => (n.attrs[spec.attr] = u) });
    }
    walkExtra(n.children, where, refs, n);
  }
}

// ───────────── Images embedded in show notes ─────────────

/** Tags whose text may hold HTML show notes. */
const HTML_TEXT_TAGS = new Set(['content:encoded', 'itunes:summary']);

const IMG_TAG_RE = /<(?:img|source)\b[^>]*>/gi;
const URL_ATTR_RE = /(\s(?:src|srcset|data-src)\s*=\s*)("([^"]*)"|'([^']*)')/gi;

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const encodeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The (decoded) URLs in one src/srcset attribute value. */
function attrUrls(name: string, raw: string): string[] {
  const value = decodeEntities(raw).trim();
  if (!/srcset/i.test(name)) return [value];
  return value.split(',').map((e) => e.trim().split(/\s+/)[0] ?? '').filter(Boolean);
}

/** Every image URL referenced by <img>/<source> tags in an HTML string. */
export function htmlImageUrls(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(IMG_TAG_RE) ?? []) {
    for (const m of tag.matchAll(URL_ATTR_RE)) out.push(...attrUrls(m[1]!, m[3] ?? m[4] ?? ''));
  }
  return out;
}

/** Replace image URLs inside <img>/<source> tags only, leaving the rest of the HTML untouched. */
export function rewriteHtmlImages(html: string, swap: (url: string) => string | undefined): string {
  return html.replace(IMG_TAG_RE, (tag) =>
    tag.replace(URL_ATTR_RE, (whole, pre: string, _q, dq: string | undefined, sq: string | undefined) => {
      const raw = dq ?? sq ?? '';
      const value = decodeEntities(raw);
      let next: string;
      if (/srcset/i.test(pre)) {
        next = value
          .split(',')
          .map((entry) => {
            const [u, ...desc] = entry.trim().split(/\s+/);
            return [u ? (swap(u) ?? u) : u, ...desc].filter(Boolean).join(' ');
          })
          .join(', ');
      } else {
        next = swap(value.trim()) ?? value;
      }
      return next === value ? whole : `${pre}"${encodeAttr(next)}"`;
    }),
  );
}

function htmlImageRefs(get: () => string | null, put: (v: string) => void, where: string, refs: MediaRef[]): void {
  const html = get();
  if (!html || !/<(?:img|source)\b/i.test(html)) return;
  for (const url of new Set(htmlImageUrls(html))) {
    if (!isHttp(url)) continue; // data: URIs, relative paths
    refs.push({
      kind: 'image',
      url,
      where,
      set: (u) => {
        const cur = get();
        if (cur) put(rewriteHtmlImages(cur, (x) => (x === url ? u : undefined)));
      },
    });
  }
}

// ───────────── Images inside JSON chapter files ─────────────

/** Image URLs in a Podcasting 2.0 JSON chapters file (`chapters[].img`). */
export function chapterImageUrls(json: unknown): string[] {
  const chapters = (json as { chapters?: unknown })?.chapters;
  if (!Array.isArray(chapters)) return [];
  return chapters.map((c) => (c as { img?: unknown })?.img).filter((u): u is string => typeof u === 'string' && isHttp(u));
}

/** Returns a copy of the chapters JSON with image URLs swapped. */
export function rewriteChapterImages(json: unknown, swap: (url: string) => string | undefined): unknown {
  const doc = json as { chapters?: unknown[] };
  if (!Array.isArray(doc?.chapters)) return json;
  return {
    ...doc,
    chapters: doc.chapters.map((c) => {
      const ch = c as { img?: unknown };
      const next = typeof ch?.img === 'string' ? swap(ch.img) : undefined;
      return next ? { ...ch, img: next } : c;
    }),
  };
}
