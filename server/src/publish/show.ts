/**
 * Show details (the feed's channel) and starting a brand-new show.
 *
 * Live items (<podcast:liveItem>) are channel tags too, but they're managed on
 * the Live tab, so they're left alone here.
 */
import type { Config } from '../config.js';
import { maybeOne, type Queryable } from '../db/db.js';
import { createPodcast, invalidateFeedCache, slugify, uniqueSlug } from '../db/podcasts.js';
import type { ItunesCategory, XmlNode } from '../feed/types.js';
import { podcastGuidFor } from '../import/importer.js';
import { ownMediaPaths } from '../media/prune.js';
import { queuePing } from '../podping/podping.js';
import { feedPath, RESERVED_SLUGS } from '../urls.js';
import { APPLE_CATEGORIES, MEDIUMS } from './categories.js';
import { PERSON_TAXONOMY, peopleFromTags, peopleToTags } from './people.js';
import {
  addNamespaces,
  bool,
  email,
  fileRef,
  httpUrl,
  insertTags,
  oneOf,
  optionalBool,
  parseTagsXml,
  PublishError,
  tagsToXml,
  text,
} from './fields.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Channel tags with their own field. */
const MANAGED = new Map<string, string>([
  ['title', 'Title'], ['description', 'Description'], ['link', 'Website'], ['language', 'Language'],
  ['copyright', 'Copyright'], ['image', 'Artwork'], ['itunes:image', 'Artwork'], ['itunes:author', 'Author'],
  ['itunes:owner', 'Owner'], ['itunes:category', 'Categories'], ['itunes:type', 'Show type'],
  ['itunes:explicit', 'Explicit'], ['itunes:block', 'Hide from Apple Podcasts'], ['itunes:complete', 'Finished'],
  ['itunes:new-feed-url', 'New feed address'], ['podcast:guid', 'set automatically'], ['podcast:locked', 'Locked'],
  ['podcast:medium', 'Medium'], ['podcast:person', 'People'], ['podcast:podping', 'set by the server'], ['podcast:liveItem', 'the Live tab'],
  ['item', 'the Episodes tab'], ['lastBuildDate', 'set automatically'], ['generator', 'set automatically'],
  ['pubDate', 'set automatically'],
]);

interface Row {
  slug: string;
  status: string;
  title: string;
  description: string | null;
  link: string | null;
  language: string | null;
  copyright: string | null;
  image_url: string | null;
  itunes_author: string | null;
  itunes_type: 'episodic' | 'serial' | null;
  itunes_explicit: boolean;
  itunes_owner_name: string | null;
  itunes_owner_email: string | null;
  itunes_categories: ItunesCategory[] | null;
  itunes_block: boolean;
  itunes_complete: boolean;
  itunes_new_feed_url: string | null;
  podcast_guid: string | null;
  podcast_locked: boolean | null;
  podcast_locked_owner: string | null;
  podcast_medium: string | null;
  extra_namespaces: Record<string, string> | null;
}

async function channelTags(q: Queryable, podcastId: string): Promise<XmlNode[]> {
  const { rows } = await q.query<{ ns_prefix: string; name: string; attributes: Record<string, string>; value: string | null; cdata: boolean; children: XmlNode[] | null }>(
    `SELECT ns_prefix, name, attributes, value, cdata, children FROM tag_elements
      WHERE podcast_id = $1 AND episode_id IS NULL AND NOT (ns_prefix = 'podcast' AND name = 'liveItem')
      ORDER BY sort_order`,
    [podcastId],
  );
  return rows.map((t) => ({
    name: t.ns_prefix ? `${t.ns_prefix}:${t.name}` : t.name,
    attrs: t.attributes,
    text: t.value ?? '',
    cdata: t.cdata,
    children: t.children ?? [],
  }));
}

export async function getShow(q: Queryable, podcastId: string) {
  const r = (await maybeOne<Row>(q, `SELECT * FROM podcasts WHERE id = $1`, [podcastId]))!;
  const tags = await channelTags(q, podcastId);
  const art = r.image_url ? await artSize(q, podcastId, r.slug, r.image_url) : null;
  const { n: episodes } = (await maybeOne<{ n: number }>(q, `SELECT count(*)::int AS n FROM episodes WHERE podcast_id = $1 AND status <> 'draft'`, [podcastId]))!;
  const show = {
    title: r.title,
    description: r.description,
    link: r.link,
    language: r.language,
    copyright: r.copyright,
    imageUrl: r.image_url,
    imageSize: art,
    author: r.itunes_author,
    ownerName: r.itunes_owner_name,
    ownerEmail: r.itunes_owner_email,
    categories: r.itunes_categories ?? [],
    explicit: r.itunes_explicit,
    type: r.itunes_type,
    complete: r.itunes_complete,
    block: r.itunes_block,
    newFeedUrl: r.itunes_new_feed_url,
    locked: r.podcast_locked,
    lockedOwner: r.podcast_locked_owner,
    medium: r.podcast_medium,
    podcastGuid: r.podcast_guid,
    people: peopleFromTags(tags),
    otherTags: tagsToXml(tags.filter((t) => t.name !== 'podcast:person')),
  };
  return { show, checklist: checklist(show, episodes), categories: APPLE_CATEGORIES, mediums: MEDIUMS, roles: PERSON_TAXONOMY };
}

async function artSize(q: Queryable, podcastId: string, slug: string, url: string) {
  const [p] = ownMediaPaths(slug, [url]);
  if (!p) return null;
  const m = await maybeOne<{ width: number | null; height: number | null }>(
    q,
    `SELECT width, height FROM media_files WHERE podcast_id = $1 AND public_path = $2`,
    [podcastId, p],
  );
  return m?.width && m.height ? { width: m.width, height: m.height } : null;
}

/** What Apple Podcasts and other directories need before they list a show. */
function checklist(s: { imageUrl: string | null; imageSize: { width: number; height: number } | null; description: string | null; categories: ItunesCategory[]; ownerEmail: string | null; author: string | null; language: string | null }, episodes: number): string[] {
  const out: string[] = [];
  if (!s.imageUrl) out.push('Add show artwork: a square JPEG or PNG, 1400 to 3000 pixels wide.');
  else if (s.imageSize) {
    const { width: w, height: h } = s.imageSize;
    if (w !== h || w < 1400 || w > 3000) out.push(`The artwork is ${w} × ${h} pixels. Apple needs a square image 1400 to 3000 pixels wide.`);
  }
  if (!s.description) out.push('Add a description.');
  if (!s.categories.length) out.push('Choose a category.');
  else {
    const bad = s.categories.filter((c) => !(c.text in APPLE_CATEGORIES) || c.sub.some((x) => !APPLE_CATEGORIES[c.text]?.includes(x)));
    if (bad.length) out.push(`“${bad.map((c) => [c.text, ...c.sub].join(' › ')).join('”, “')}” isn’t a current Apple Podcasts category. Pick one from the list.`);
  }
  if (!s.author) out.push('Add the author (the name listeners see under the title).');
  if (!s.ownerEmail) out.push('Add an owner email. Apple and Spotify send ownership checks there; it isn’t shown to listeners in most apps.');
  if (!s.language) out.push('Set the language.');
  if (!episodes) out.push('Publish at least one episode. Directories won’t accept an empty feed.');
  return out;
}

export interface ShowInput {
  title?: unknown;
  description?: unknown;
  link?: unknown;
  language?: unknown;
  copyright?: unknown;
  image?: unknown;
  author?: unknown;
  ownerName?: unknown;
  ownerEmail?: unknown;
  categories?: unknown;
  explicit?: unknown;
  type?: unknown;
  complete?: unknown;
  block?: unknown;
  newFeedUrl?: unknown;
  locked?: unknown;
  lockedOwner?: unknown;
  medium?: unknown;
  people?: unknown;
  otherTags?: unknown;
}

function categories(v: unknown): ItunesCategory[] {
  if (v === null) return [];
  if (!Array.isArray(v)) throw new PublishError('Categories must be a list');
  if (v.length > 3) throw new PublishError('Choose at most 3 categories');
  return v.map((c, i) => {
    const o = (c ?? {}) as { text?: unknown; sub?: unknown };
    const name = text(o.text, `Category ${i + 1}`, { required: true, max: 100 })!;
    const sub = o.sub === undefined || o.sub === null ? [] : o.sub;
    if (!Array.isArray(sub) || sub.length > 3 || sub.some((s) => typeof s !== 'string' || !s.trim() || s.length > 100)) {
      throw new PublishError(`Category ${i + 1} subcategories must be a list of names`);
    }
    return { text: name, sub: sub.map((s: string) => s.trim()) };
  });
}

/** Returns media paths the show stopped using (old artwork, say) for the caller to prune after commit. */
export async function updateShow(q: Queryable, config: Config, podcastId: string, input: ShowInput): Promise<{ dropped: string[] }> {
  const r = (await maybeOne<Row>(q, `SELECT * FROM podcasts WHERE id = $1 FOR UPDATE`, [podcastId]))!;
  if (r.status !== 'active') throw new PublishError('This show is still importing. Wait for the import to finish before editing.', 409);
  const n = { ...r };
  const has = (k: keyof ShowInput) => input[k] !== undefined;

  if (has('title')) n.title = text(input.title, 'Title', { required: true, max: 1000 })!;
  if (has('description')) n.description = text(input.description, 'Description', { max: 200_000 });
  if (has('link')) n.link = httpUrl(input.link, 'Website');
  if (has('language')) {
    n.language = text(input.language, 'Language', { max: 35 });
    if (n.language && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(n.language)) throw new PublishError('Language must be a code like en or en-us');
  }
  if (has('copyright')) n.copyright = text(input.copyright, 'Copyright', { max: 1000 });
  if (has('image')) n.image_url = (await fileRef(q, config, podcastId, input.image, 'Artwork', ['image']))?.url ?? null;
  if (has('author')) n.itunes_author = text(input.author, 'Author', { max: 1000 });
  if (has('ownerName')) n.itunes_owner_name = text(input.ownerName, 'Owner name', { max: 1000 });
  if (has('ownerEmail')) n.itunes_owner_email = email(input.ownerEmail, 'Owner email');
  if (has('categories')) n.itunes_categories = categories(input.categories);
  if (has('explicit')) n.itunes_explicit = bool(input.explicit, 'Explicit');
  if (has('type')) n.itunes_type = oneOf(input.type, 'Show type', ['episodic', 'serial'] as const);
  if (has('complete')) n.itunes_complete = bool(input.complete, 'Finished');
  if (has('block')) n.itunes_block = bool(input.block, 'Hide from Apple Podcasts');
  if (has('newFeedUrl')) n.itunes_new_feed_url = httpUrl(input.newFeedUrl, 'New feed address');
  if (has('locked')) n.podcast_locked = optionalBool(input.locked, 'Locked');
  if (has('lockedOwner')) n.podcast_locked_owner = email(input.lockedOwner, 'Lock owner email');
  if (has('medium')) n.podcast_medium = oneOf(input.medium, 'Medium', MEDIUMS);

  await q.query(
    `UPDATE podcasts SET title = $2, description = $3, link = $4, language = $5, copyright = $6, image_url = $7,
            itunes_author = $8, itunes_owner_name = $9, itunes_owner_email = $10, itunes_categories = $11,
            itunes_explicit = $12, itunes_type = $13, itunes_complete = $14, itunes_block = $15,
            itunes_new_feed_url = $16, podcast_locked = $17, podcast_locked_owner = $18, podcast_medium = $19,
            updated_at = now()
      WHERE id = $1`,
    [
      podcastId, n.title, n.description, n.link, n.language, n.copyright, n.image_url,
      n.itunes_author, n.itunes_owner_name, n.itunes_owner_email, JSON.stringify(n.itunes_categories ?? []),
      n.itunes_explicit, n.itunes_type, n.itunes_complete, n.itunes_block,
      n.itunes_new_feed_url, n.podcast_locked, n.podcast_locked_owner, n.podcast_medium,
    ],
  );

  const oldTags = await channelTags(q, podcastId);
  if (has('otherTags') || has('people')) {
    // Keep the stored order unless that part changed.
    let others = oldTags.filter((t) => t.name !== 'podcast:person');
    let people = oldTags.filter((t) => t.name === 'podcast:person');
    let ns: Record<string, string> = {};
    if (has('otherTags')) {
      const parsed = parseTagsXml(input.otherTags, r.extra_namespaces ?? {}, MANAGED);
      others = parsed.nodes;
      ns = parsed.namespaces;
    }
    if (has('people')) people = await peopleToTags(q, config, podcastId, input.people);
    await q.query(
      `DELETE FROM tag_elements WHERE podcast_id = $1 AND episode_id IS NULL AND NOT (ns_prefix = 'podcast' AND name = 'liveItem')`,
      [podcastId],
    );
    await insertTags(q, podcastId, null, [...people, ...others], { ...(r.extra_namespaces ?? {}), ...ns });
    await addNamespaces(q, podcastId, ns);
  }
  await invalidateFeedCache(q, podcastId);
  await queuePing(q, config, podcastId, 'update');

  const urlsOf = (row: Row, tags: XmlNode[]) => {
    const urls: (string | null)[] = [row.image_url, ...(row.description ?? '').split(/["'\s]/)];
    const walk = (t: XmlNode) => {
      urls.push(...Object.values(t.attrs), t.text);
      t.children.forEach(walk);
    };
    tags.forEach(walk);
    return ownMediaPaths(r.slug, urls);
  };
  const keep = new Set(urlsOf(n, has('otherTags') || has('people') ? await channelTags(q, podcastId) : oldTags));
  return { dropped: urlsOf(r, oldTags).filter((p) => !keep.has(p)) };
}

/** Start a show from scratch. Podping starts on, since there's no old host to move away from. */
export async function createShow(q: Queryable, config: Config, ownerId: string, input: ShowInput & { slug?: unknown }): Promise<string> {
  const title = text(input.title, 'Title', { required: true, max: 1000 })!;
  let slug: string;
  if (input.slug !== undefined && input.slug !== null && input.slug !== '') {
    if (typeof input.slug !== 'string' || !SLUG_RE.test(input.slug)) {
      throw new PublishError('Feed address may only use lowercase letters, numbers and dashes');
    }
    if (RESERVED_SLUGS.has(input.slug)) throw new PublishError(`"${input.slug}" is reserved; choose a different feed address`);
    if (await maybeOne(q, `SELECT 1 FROM podcasts WHERE slug = $1`, [input.slug])) {
      throw new PublishError(`The feed address "${input.slug}" is already taken`, 409);
    }
    slug = input.slug;
  } else {
    slug = await uniqueSlug(q, slugify(title));
  }
  const id = await createPodcast(q, { ownerId, slug, sourceUrl: null, title, status: 'active' });
  const guid = podcastGuidFor(config.publicBaseUrl + feedPath(slug));
  if (await maybeOne(q, `SELECT 1 FROM podcasts WHERE owner_id = $1 AND podcast_guid = $2`, [ownerId, guid])) {
    throw new PublishError('You already have a show with this feed address', 409);
  }
  await q.query(
    `UPDATE podcasts SET podcast_guid = $2, podping_enabled = true, itunes_type = 'episodic', language = 'en' WHERE id = $1`,
    [id, guid],
  );
  const { slug: _s, ...rest } = input;
  await updateShow(q, config, id, { ...rest, title });
  return id;
}
