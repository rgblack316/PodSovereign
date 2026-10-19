/** Canonical prefix → namespace URI used when writing feeds. */
export const CANONICAL_NS: Record<string, string> = {
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
  podcast: 'https://podcastindex.org/namespace/1.0',
  content: 'http://purl.org/rss/1.0/modules/content/',
  atom: 'http://www.w3.org/2005/Atom',
  googleplay: 'http://www.google.com/schemas/play-podcasts/1.0',
  psc: 'http://podlove.org/simple-chapters',
  media: 'http://search.yahoo.com/mrss/',
  dc: 'http://purl.org/dc/elements/1.1/',
};

/** Always declared on output, even if unused. */
export const ALWAYS_DECLARED = ['itunes', 'podcast', 'content', 'atom'];

/**
 * Namespace URI (lower-cased) → canonical prefix. Lets us read feeds that use
 * odd prefixes (e.g. xmlns:pi="https://podcastindex.org/namespace/1.0") or
 * older URIs and normalise them.
 */
const URI_TO_PREFIX: Record<string, string> = {
  'https://github.com/podcastindex-org/podcast-namespace/blob/main/docs/1.0.md': 'podcast',
  'http://podcastindex.org/namespace/1.0': 'podcast',
  'https://www.itunes.com/dtds/podcast-1.0.dtd': 'itunes',
  'http://www.w3.org/2005/atom/': 'atom',
};
for (const [prefix, uri] of Object.entries(CANONICAL_NS)) URI_TO_PREFIX[uri.toLowerCase()] = prefix;

export function canonicalPrefix(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  return URI_TO_PREFIX[uri.toLowerCase()] ?? URI_TO_PREFIX[uri.toLowerCase().replace(/\/$/, '')];
}
