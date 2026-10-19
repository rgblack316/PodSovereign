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
