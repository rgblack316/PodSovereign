import { detectPrefixes, type PrefixSetting } from './prefixes.js';
import type { Channel, EpisodeType, Feed, Item, ItunesCategory, XmlNode } from './types.js';
import { parseXml } from './xml.js';

export interface ParseResult {
  feed: Feed;
  warnings: string[];
  /** Prefix chain found on the source enclosures (from the newest episode that had one). */
  detectedPrefixes: PrefixSetting[];
  /** Defunct prefixes that were stripped, e.g. Chartable. */
  removedPrefixes: string[];
}

export class FeedParseError extends Error {}

/** Tags the builder regenerates itself, so they're dropped on import. */
const CHANNEL_REGENERATED = new Set(['lastBuildDate', 'generator', 'pubDate']);

const text = (n: XmlNode | undefined): string | null => (n && n.text !== '' ? n.text : null);
const child = (n: XmlNode, name: string) => n.children.find((c) => c.name === name);

export function parseBool(v: string | null | undefined): boolean | null {
  if (v == null) return null;
  const s = v.trim().toLowerCase();
  if (['true', 'yes', 'explicit', '1'].includes(s)) return true;
  if (['false', 'no', 'clean', '0'].includes(s)) return false;
  return null;
}

/** "3600", "62:03", "1:02:03", "01:02:03.500" → seconds. */
export function parseDuration(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  return Math.round(parts.reduce((acc, p) => acc * 60 + Number(p), 0));
}

function parseIntOrNull(v: string | null): number | null {
  if (!v || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

export function parseFeed(xml: string): ParseResult {
  const { root, namespaces, warnings } = parseXml(xml);
  if (root.name !== 'rss') throw new FeedParseError(`Expected an RSS feed, got <${root.name}>`);
  const ch = child(root, 'channel');
  if (!ch) throw new FeedParseError('RSS feed has no <channel>');

  const channel: Channel = {
    title: '',
    description: null,
    link: null,
    language: null,
    copyright: null,
    imageUrl: null,
    itunesAuthor: null,
    itunesType: null,
    itunesExplicit: false,
    itunesOwnerName: null,
    itunesOwnerEmail: null,
    itunesCategories: [],
    itunesBlock: false,
    itunesComplete: false,
    itunesNewFeedUrl: null,
    podcastGuid: null,
    podcastLocked: null,
    podcastLockedOwner: null,
    podcastMedium: null,
    extra: [],
  };
  const items: Item[] = [];
  let rssImageUrl: string | null = null;
  let detectedPrefixes: PrefixSetting[] = [];
  const removed = new Set<string>();

  for (const n of ch.children) {
    switch (n.name) {
      case 'title': channel.title = n.text; break;
      case 'description': channel.description = text(n); break;
      case 'link': channel.link = text(n); break;
      case 'language': channel.language = text(n); break;
      case 'copyright': channel.copyright = text(n); break;
      case 'image': rssImageUrl = text(child(n, 'url')); break;
      case 'itunes:image': channel.imageUrl = n.attrs.href ?? text(n); break;
      case 'itunes:author': channel.itunesAuthor = text(n); break;
      case 'itunes:type': {
        const t = n.text.toLowerCase();
        channel.itunesType = t === 'serial' || t === 'episodic' ? t : null;
        break;
      }
      case 'itunes:explicit': channel.itunesExplicit = parseBool(n.text) ?? false; break;
      case 'itunes:owner':
        channel.itunesOwnerName = text(child(n, 'itunes:name'));
        channel.itunesOwnerEmail = text(child(n, 'itunes:email'));
        break;
      case 'itunes:category': channel.itunesCategories.push(parseCategory(n)); break;
      case 'itunes:block': channel.itunesBlock = parseBool(n.text) ?? false; break;
      case 'itunes:complete': channel.itunesComplete = parseBool(n.text) ?? false; break;
      case 'itunes:new-feed-url': channel.itunesNewFeedUrl = text(n); break;
      case 'podcast:guid': channel.podcastGuid = text(n); break;
      case 'podcast:locked':
        channel.podcastLocked = parseBool(n.text);
        channel.podcastLockedOwner = n.attrs.owner ?? null;
        break;
      case 'podcast:medium': channel.podcastMedium = text(n); break;
      case 'atom:link':
        // Self/hub links point at the old host — the builder writes our own.
        if (n.attrs.rel !== 'self' && n.attrs.rel !== 'hub') channel.extra.push(n);
        break;
      case 'item': {
        const { item, detected } = parseItem(n, warnings, removed);
        items.push(item);
        if (!detectedPrefixes.length && detected.length) detectedPrefixes = detected;
        break;
      }
      default:
        if (!CHANNEL_REGENERATED.has(n.name)) channel.extra.push(n);
    }
  }

  channel.imageUrl ??= rssImageUrl;
  if (!channel.title) warnings.push('Channel has no <title>');
  if (channel.podcastLocked) {
    warnings.push(
      'Feed has <podcast:locked>yes</podcast:locked>. The podcaster must unlock it at the current host before moving it.',
    );
  }

  return {
    feed: { channel, items, namespaces },
    warnings,
    detectedPrefixes,
    removedPrefixes: [...removed],
  };
}

function parseCategory(n: XmlNode): ItunesCategory {
  return {
    text: n.attrs.text ?? '',
    sub: n.children.filter((c) => c.name === 'itunes:category').map((c) => c.attrs.text ?? ''),
  };
}

function parseItem(n: XmlNode, warnings: string[], removed: Set<string>): { item: Item; detected: PrefixSetting[] } {
  const item: Item = {
    guid: '',
    guidIsPermalink: null,
    pubDate: null,
    title: '',
    description: null,
    link: null,
    enclosureUrl: null,
    enclosureLength: null,
    enclosureType: null,
    itunesTitle: null,
    itunesDuration: null,
    itunesEpisode: null,
    itunesSeason: null,
    itunesEpisodeType: null,
    itunesExplicit: null,
    itunesImageUrl: null,
    itunesBlock: false,
    extra: [],
  };
  let detected: PrefixSetting[] = [];
  let rawEnclosureUrl: string | null = null;

  for (const c of n.children) {
    switch (c.name) {
      case 'title': item.title = c.text; break;
      case 'description': item.description = text(c); break;
      case 'link': item.link = text(c); break;
      case 'guid':
        item.guid = c.text;
        item.guidIsPermalink = c.attrs.isPermaLink === undefined ? null : parseBool(c.attrs.isPermaLink);
        break;
      case 'pubDate': {
        const d = new Date(c.text);
        if (Number.isNaN(d.getTime())) warnings.push(`Unparseable pubDate "${c.text}"`);
        else item.pubDate = d;
        break;
      }
      case 'enclosure': {
        const url = c.attrs.url ?? null;
        rawEnclosureUrl = url;
        if (url) {
          const r = detectPrefixes(url);
          item.enclosureUrl = r.cleanUrl;
          detected = r.detected;
          r.removed.forEach((p) => removed.add(p));
        }
        item.enclosureLength = parseIntOrNull(c.attrs.length ?? null);
        item.enclosureType = c.attrs.type ?? null;
        break;
      }
      case 'itunes:title': item.itunesTitle = text(c); break;
      case 'itunes:duration': item.itunesDuration = parseDuration(c.text); break;
      case 'itunes:episode': item.itunesEpisode = parseIntOrNull(c.text); break;
      case 'itunes:season': item.itunesSeason = parseIntOrNull(c.text); break;
      case 'itunes:episodeType': {
        const t = c.text.toLowerCase();
        item.itunesEpisodeType = (['full', 'trailer', 'bonus'] as const).includes(t as EpisodeType) ? (t as EpisodeType) : null;
        break;
      }
      case 'itunes:explicit': item.itunesExplicit = parseBool(c.text); break;
      case 'itunes:image': item.itunesImageUrl = c.attrs.href ?? text(c); break;
      case 'itunes:block': item.itunesBlock = parseBool(c.text) ?? false; break;
      default: item.extra.push(c);
    }
  }

  // Apple and Podcast Index key episodes on guid; fall back to the enclosure URL, like most apps do.
  if (!item.guid) {
    // Use the URL exactly as apps saw it (with any prefixes) so they don't re-download.
    item.guid = rawEnclosureUrl ?? item.link ?? item.title;
    warnings.push(`Episode "${item.title}" has no <guid>; using ${rawEnclosureUrl ? 'enclosure URL' : 'link/title'}`);
  }
  return { item, detected };
}
