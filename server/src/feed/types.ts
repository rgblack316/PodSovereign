/**
 * In-memory feed model. Mirrors the DB schema: typed fields for the tags the
 * dashboard edits, plus `extra` — an ordered list of raw XML nodes that holds
 * every other tag (all remaining iTunes / Podcasting 2.0 tags, and any unknown
 * namespace) so nothing is lost on import → export.
 */

export interface XmlNode {
  /** Qualified name with canonical prefix, e.g. "podcast:person", "itunes:summary", "title". */
  name: string;
  attrs: Record<string, string>;
  text: string;
  /** Source used CDATA — re-emitted as CDATA. */
  cdata: boolean;
  children: XmlNode[];
}

export interface ItunesCategory {
  text: string;
  sub: string[];
}

export interface Channel {
  title: string;
  description: string | null;
  link: string | null;
  language: string | null;
  copyright: string | null;
  imageUrl: string | null;

  itunesAuthor: string | null;
  itunesType: 'episodic' | 'serial' | null;
  itunesExplicit: boolean;
  itunesOwnerName: string | null;
  itunesOwnerEmail: string | null;
  itunesCategories: ItunesCategory[];
  itunesBlock: boolean;
  itunesComplete: boolean;
  itunesNewFeedUrl: string | null;

  podcastGuid: string | null;
  podcastLocked: boolean | null;
  podcastLockedOwner: string | null;
  podcastMedium: string | null;

  extra: XmlNode[];
}

export type EpisodeType = 'full' | 'trailer' | 'bonus';
export type EpisodeStatus = 'draft' | 'scheduled' | 'published';

export interface Item {
  guid: string;
  /** null = attribute absent in source (RSS default applies). */
  guidIsPermalink: boolean | null;
  status?: EpisodeStatus;
  pubDate: Date | null;

  title: string;
  description: string | null;
  link: string | null;

  /** Always stored WITHOUT stats prefixes; prefixes are added at render time. */
  enclosureUrl: string | null;
  enclosureLength: number | null;
  enclosureType: string | null;

  itunesTitle: string | null;
  itunesDuration: number | null; // seconds
  itunesEpisode: number | null;
  itunesSeason: number | null;
  itunesEpisodeType: EpisodeType | null;
  itunesExplicit: boolean | null;
  itunesImageUrl: string | null;
  itunesBlock: boolean;

  extra: XmlNode[];
}

export interface Feed {
  channel: Channel;
  items: Item[];
  /** Namespaces declared by the source that aren't built-in (prefix → URI). */
  namespaces: Record<string, string>;
}
