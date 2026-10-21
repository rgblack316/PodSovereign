import { ALWAYS_DECLARED, CANONICAL_NS } from './namespaces.js';
import { applyPrefixes } from './prefixes.js';
import type { Feed, Item, XmlNode } from './types.js';
import { attrString, el, serializeNode } from './xml.js';

export interface BuildOptions {
  /** Public URL of this feed (atom:link rel="self"). */
  selfUrl?: string;
  /** Optional WebSub hub for instant updates. */
  hubUrl?: string;
  /** Resolved prefix chain, outermost first (see buildPrefixChain). */
  prefixChain?: string[];
  /** Also prefix podcast:alternateEnclosure http(s) sources. Default false. */
  prefixAlternateEnclosures?: boolean;
  generator?: string;
  /** Add <podcast:podping usesPodping="true"/> — this server announces changes via Podping. */
  usesPodping?: boolean;
  /** Hide drafts and episodes scheduled in the future. Default true. */
  publishedOnly?: boolean;
  now?: Date;
}

const I1 = '  ';
const I2 = '    ';
const I3 = '      ';

const bool = (b: boolean) => (b ? 'true' : 'false');
const yes = (b: boolean) => (b ? 'Yes' : 'No');

export function buildFeed(feed: Feed, opts: BuildOptions = {}): string {
  const now = opts.now ?? new Date();
  const chain = opts.prefixChain ?? [];
  const c = feed.channel;
  const lines: string[] = [];
  const push = (indent: string, s: string) => s && lines.push(indent + s);

  // Channel
  push(I2, el('title', c.title));
  push(I2, el('link', c.link));
  push(I2, el('description', c.description, {}, true));
  push(I2, el('language', c.language));
  push(I2, el('copyright', c.copyright));
  if (opts.selfUrl) push(I2, `<atom:link${attrString({ href: opts.selfUrl, rel: 'self', type: 'application/rss+xml' })}/>`);
  if (opts.hubUrl) push(I2, `<atom:link${attrString({ href: opts.hubUrl, rel: 'hub' })}/>`);
  push(I2, el('lastBuildDate', now.toUTCString()));
  push(I2, el('generator', opts.generator ?? 'PodSovereign'));
  if (c.imageUrl) {
    lines.push(`${I2}<image>`);
    push(I3, el('url', c.imageUrl));
    push(I3, el('title', c.title));
    push(I3, el('link', c.link));
    lines.push(`${I2}</image>`);
    push(I2, `<itunes:image${attrString({ href: c.imageUrl })}/>`);
  }
  push(I2, el('itunes:author', c.itunesAuthor));
  if (c.itunesOwnerName || c.itunesOwnerEmail) {
    lines.push(`${I2}<itunes:owner>`);
    push(I3, el('itunes:name', c.itunesOwnerName));
    push(I3, el('itunes:email', c.itunesOwnerEmail));
    lines.push(`${I2}</itunes:owner>`);
  }
  for (const cat of c.itunesCategories) {
    if (!cat.sub.length) push(I2, `<itunes:category${attrString({ text: cat.text })}/>`);
    else {
      lines.push(`${I2}<itunes:category${attrString({ text: cat.text })}>`);
      for (const s of cat.sub) push(I3, `<itunes:category${attrString({ text: s })}/>`);
      lines.push(`${I2}</itunes:category>`);
    }
  }
  push(I2, el('itunes:type', c.itunesType));
  push(I2, el('itunes:explicit', bool(c.itunesExplicit)));
  if (c.itunesBlock) push(I2, el('itunes:block', 'Yes'));
  if (c.itunesComplete) push(I2, el('itunes:complete', 'Yes'));
  push(I2, el('itunes:new-feed-url', c.itunesNewFeedUrl));
  push(I2, el('podcast:guid', c.podcastGuid));
  if (c.podcastLocked !== null || c.podcastLockedOwner) {
    push(I2, el('podcast:locked', c.podcastLocked ? 'yes' : 'no', { owner: c.podcastLockedOwner }));
  }
  push(I2, el('podcast:medium', c.podcastMedium));
  if (opts.usesPodping) push(I2, `<podcast:podping usesPodping="true"/>`);
  for (const n of c.extra) lines.push(serializeNode(n, I2));

  // Items
  const publishedOnly = opts.publishedOnly ?? true;
  for (const item of feed.items) {
    if (publishedOnly && !isPublic(item, now)) continue;
    lines.push(`${I2}<item>`);
    buildItem(item, chain, opts, lines);
    lines.push(`${I2}</item>`);
  }

  const used = collectPrefixes(feed);
  const ns: Record<string, string> = {};
  for (const p of new Set([...ALWAYS_DECLARED, ...used])) {
    const uri = CANONICAL_NS[p] ?? feed.namespaces[p];
    if (uri) ns[`xmlns:${p}`] = uri;
  }
  for (const [p, uri] of Object.entries(feed.namespaces)) ns[`xmlns:${p}`] ??= uri;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0"${attrString(ns)}>`,
    `${I1}<channel>`,
    ...lines,
    `${I1}</channel>`,
    '</rss>',
    '',
  ].join('\n');
}

function isPublic(item: Item, now: Date): boolean {
  if (item.status && item.status !== 'published' && item.status !== 'scheduled') return false;
  if (item.pubDate && item.pubDate.getTime() > now.getTime()) return false;
  return true;
}

function buildItem(item: Item, chain: string[], opts: BuildOptions, lines: string[]): void {
  const push = (s: string) => s && lines.push(I3 + s);
  push(el('title', item.title));
  push(el('description', item.description, {}, true));
  push(el('link', item.link));
  push(
    el('guid', item.guid, {
      isPermaLink: item.guidIsPermalink === null ? null : bool(item.guidIsPermalink),
    }),
  );
  if (item.pubDate) push(el('pubDate', item.pubDate.toUTCString()));
  if (item.enclosureUrl) {
    push(
      `<enclosure${attrString({
        url: applyPrefixes(item.enclosureUrl, chain),
        length: item.enclosureLength ?? 0,
        type: item.enclosureType ?? 'audio/mpeg',
      })}/>`,
    );
  }
  push(el('itunes:title', item.itunesTitle));
  if (item.itunesImageUrl) push(`<itunes:image${attrString({ href: item.itunesImageUrl })}/>`);
  push(el('itunes:duration', item.itunesDuration));
  push(el('itunes:episode', item.itunesEpisode));
  push(el('itunes:season', item.itunesSeason));
  push(el('itunes:episodeType', item.itunesEpisodeType));
  if (item.itunesExplicit !== null) push(el('itunes:explicit', bool(item.itunesExplicit)));
  if (item.itunesBlock) push(el('itunes:block', yes(true)));

  for (const n of item.extra) {
    const node = opts.prefixAlternateEnclosures && chain.length ? prefixAltEnclosure(n, chain) : n;
    lines.push(serializeNode(node, I3));
  }
}

/** Returns a copy of an alternateEnclosure node with prefixed http(s) sources. */
function prefixAltEnclosure(n: XmlNode, chain: string[]): XmlNode {
  if (n.name !== 'podcast:alternateEnclosure') return n;
  return {
    ...n,
    children: n.children.map((c) =>
      c.name === 'podcast:source' && /^https?:\/\//i.test(c.attrs.uri ?? '')
        ? { ...c, attrs: { ...c.attrs, uri: applyPrefixes(c.attrs.uri!, chain) } }
        : c,
    ),
  };
}

function collectPrefixes(feed: Feed): Set<string> {
  const out = new Set<string>();
  const walk = (n: XmlNode) => {
    const i = n.name.indexOf(':');
    if (i > 0) out.add(n.name.slice(0, i));
    for (const k of Object.keys(n.attrs)) {
      const j = k.indexOf(':');
      if (j > 0 && !k.startsWith('xml:')) out.add(k.slice(0, j));
    }
    n.children.forEach(walk);
  };
  feed.channel.extra.forEach(walk);
  feed.items.forEach((it) => it.extra.forEach(walk));
  return out;
}
