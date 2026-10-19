import { CANONICAL_NS } from '../feed/namespaces.js';
import { buildPrefixChain, type PrefixSetting } from '../feed/prefixes.js';
import type { Channel, EpisodeStatus, EpisodeType, Feed, Item, XmlNode } from '../feed/types.js';
import { maybeOne, one, type Queryable } from './db.js';

export type Role = 'owner' | 'editor' | 'viewer';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/**
 * The single access check every podcast-scoped route goes through.
 * Returns null both when the podcast doesn't exist and when the user has no
 * access, so callers answer 404 either way and never reveal other users' shows.
 */
export async function podcastRole(q: Queryable, userId: string, podcastId: string): Promise<Role | null> {
  if (!isUuid(podcastId)) return null;
  const row = await maybeOne<{ role: Role }>(
    q,
    `SELECT CASE WHEN p.owner_id = $1 THEN 'owner' ELSE m.role END AS role
       FROM podcasts p
       LEFT JOIN podcast_members m ON m.podcast_id = p.id AND m.user_id = $1
      WHERE p.id = $2 AND (p.owner_id = $1 OR m.user_id IS NOT NULL)`,
    [userId, podcastId],
  );
  return row?.role ?? null;
}

export interface PodcastSummary {
  id: string;
  slug: string;
  title: string;
  image_url: string | null;
  status: string;
  role: Role;
  episode_count: number;
}

export async function listPodcastsForUser(q: Queryable, userId: string): Promise<PodcastSummary[]> {
  const { rows } = await q.query<PodcastSummary>(
    `SELECT p.id, p.slug, p.title, p.image_url, p.status,
            CASE WHEN p.owner_id = $1 THEN 'owner' ELSE m.role END AS role,
            (SELECT count(*)::int FROM episodes e WHERE e.podcast_id = p.id) AS episode_count
       FROM podcasts p
       LEFT JOIN podcast_members m ON m.podcast_id = p.id AND m.user_id = $1
      WHERE p.owner_id = $1 OR m.user_id IS NOT NULL
      ORDER BY p.title`,
    [userId],
  );
  return rows;
}

// ───────────── Slugs ─────────────

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'podcast';
}

export async function uniqueSlug(q: Queryable, base: string): Promise<string> {
  const { rows } = await q.query<{ slug: string }>(
    `SELECT slug FROM podcasts WHERE slug = $1 OR slug LIKE $1 || '-%'`,
    [base],
  );
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ───────────── Writing a feed ─────────────

export async function createPodcast(
  q: Queryable,
  opts: { ownerId: string; slug: string; sourceUrl: string | null; title: string; status?: 'importing' | 'active' },
): Promise<string> {
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO podcasts (owner_id, slug, source_feed_url, title, status, imported_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [opts.ownerId, opts.slug, opts.sourceUrl, opts.title || 'Untitled podcast', opts.status ?? 'active'],
  );
  return r.id;
}

function splitName(name: string): { prefix: string; local: string } {
  const i = name.indexOf(':');
  return i > 0 ? { prefix: name.slice(0, i), local: name.slice(i + 1) } : { prefix: '', local: name };
}

function tagRows(nodes: XmlNode[], namespaces: Record<string, string>, episodeGuid: string | null) {
  return nodes.map((n, i) => {
    const { prefix, local } = splitName(n.name);
    return {
      episode_guid: episodeGuid,
      ns_uri: prefix ? (CANONICAL_NS[prefix] ?? namespaces[prefix] ?? '') : '',
      ns_prefix: prefix,
      name: local,
      attributes: n.attrs,
      value: n.text || null,
      cdata: n.cdata,
      children: n.children.length ? n.children : null,
      sort_order: i,
    };
  });
}

/**
 * Replace a podcast's stored content with `feed`: updates the channel row,
 * upserts episodes by guid (keeping their ids), deletes episodes no longer
 * present, and rewrites the generic tag store. Call inside a transaction.
 */
export async function writeFeedContent(q: Queryable, podcastId: string, feed: Feed): Promise<void> {
  const c = feed.channel;
  const guids = new Set<string>();
  for (const it of feed.items) {
    if (guids.has(it.guid)) throw new Error(`Duplicate episode guid "${it.guid}"`);
    guids.add(it.guid);
  }

  await q.query(
    `UPDATE podcasts SET
       title = $2, description = $3, link = $4, language = $5, copyright = $6, image_url = $7,
       itunes_author = $8, itunes_type = $9, itunes_explicit = $10, itunes_owner_name = $11,
       itunes_owner_email = $12, itunes_categories = $13, itunes_block = $14, itunes_complete = $15,
       itunes_new_feed_url = $16, podcast_guid = $17, podcast_locked = $18, podcast_locked_owner = $19,
       podcast_medium = $20, extra_namespaces = $21, feed_cache_xml = NULL, feed_cache_etag = NULL,
       updated_at = now()
     WHERE id = $1`,
    [
      podcastId, c.title, c.description, c.link, c.language, c.copyright, c.imageUrl,
      c.itunesAuthor, c.itunesType, c.itunesExplicit, c.itunesOwnerName,
      c.itunesOwnerEmail, JSON.stringify(c.itunesCategories), c.itunesBlock, c.itunesComplete,
      c.itunesNewFeedUrl, c.podcastGuid, c.podcastLocked, c.podcastLockedOwner,
      c.podcastMedium, JSON.stringify(feed.namespaces),
    ],
  );

  const episodes = feed.items.map((it, i) => ({
    guid: it.guid,
    guid_is_permalink: it.guidIsPermalink,
    status: it.status ?? 'published',
    pub_date: it.pubDate?.toISOString() ?? null,
    title: it.title,
    description: it.description,
    link: it.link,
    enclosure_url: it.enclosureUrl,
    enclosure_length: it.enclosureLength,
    enclosure_type: it.enclosureType,
    itunes_title: it.itunesTitle,
    itunes_duration: it.itunesDuration,
    itunes_episode: it.itunesEpisode,
    itunes_season: it.itunesSeason,
    itunes_episode_type: it.itunesEpisodeType,
    itunes_explicit: it.itunesExplicit,
    itunes_image_url: it.itunesImageUrl,
    itunes_block: it.itunesBlock,
    sort_index: i,
  }));

  await q.query(
    `INSERT INTO episodes (podcast_id, guid, guid_is_permalink, status, pub_date, title, description, link,
       enclosure_url, enclosure_length, enclosure_type, itunes_title, itunes_duration, itunes_episode,
       itunes_season, itunes_episode_type, itunes_explicit, itunes_image_url, itunes_block, sort_index)
     SELECT $1, x.guid, x.guid_is_permalink, x.status, x.pub_date, x.title, x.description, x.link,
       x.enclosure_url, x.enclosure_length, x.enclosure_type, x.itunes_title, x.itunes_duration, x.itunes_episode,
       x.itunes_season, x.itunes_episode_type, x.itunes_explicit, x.itunes_image_url, x.itunes_block, x.sort_index
       FROM jsonb_to_recordset($2::jsonb) AS x(guid text, guid_is_permalink boolean, status text, pub_date timestamptz,
         title text, description text, link text, enclosure_url text, enclosure_length bigint, enclosure_type text,
         itunes_title text, itunes_duration int, itunes_episode int, itunes_season int, itunes_episode_type text,
         itunes_explicit boolean, itunes_image_url text, itunes_block boolean, sort_index int)
     ON CONFLICT (podcast_id, guid) DO UPDATE SET
       guid_is_permalink = EXCLUDED.guid_is_permalink, status = EXCLUDED.status, pub_date = EXCLUDED.pub_date,
       title = EXCLUDED.title, description = EXCLUDED.description, link = EXCLUDED.link,
       enclosure_url = EXCLUDED.enclosure_url, enclosure_length = EXCLUDED.enclosure_length,
       enclosure_type = EXCLUDED.enclosure_type, itunes_title = EXCLUDED.itunes_title,
       itunes_duration = EXCLUDED.itunes_duration, itunes_episode = EXCLUDED.itunes_episode,
       itunes_season = EXCLUDED.itunes_season, itunes_episode_type = EXCLUDED.itunes_episode_type,
       itunes_explicit = EXCLUDED.itunes_explicit, itunes_image_url = EXCLUDED.itunes_image_url,
       itunes_block = EXCLUDED.itunes_block, sort_index = EXCLUDED.sort_index, updated_at = now()`,
    [podcastId, JSON.stringify(episodes)],
  );
  await q.query(
    `DELETE FROM episodes WHERE podcast_id = $1
       AND guid NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [podcastId, JSON.stringify([...guids])],
  );

  const tags = [
    ...tagRows(c.extra, feed.namespaces, null),
    ...feed.items.flatMap((it) => tagRows(it.extra, feed.namespaces, it.guid)),
  ];
  await q.query(`DELETE FROM tag_elements WHERE podcast_id = $1`, [podcastId]);
  if (tags.length) {
    await q.query(
      `INSERT INTO tag_elements (podcast_id, episode_id, ns_uri, ns_prefix, name, attributes, value, cdata, children, sort_order)
       SELECT $1, e.id, x.ns_uri, x.ns_prefix, x.name, x.attributes, x.value, x.cdata, x.children, x.sort_order
         FROM json_to_recordset($2::json) AS x(episode_guid text, ns_uri text, ns_prefix text, name text,
              attributes json, value text, cdata boolean, children json, sort_order int)
         LEFT JOIN episodes e ON e.podcast_id = $1 AND e.guid = x.episode_guid`,
      [podcastId, JSON.stringify(tags)],
    );
  }
}

// ───────────── Reading a feed ─────────────

interface PodcastRow {
  id: string;
  slug: string;
  owner_id: string;
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
  itunes_categories: Channel['itunesCategories'] | null;
  itunes_block: boolean;
  itunes_complete: boolean;
  itunes_new_feed_url: string | null;
  podcast_guid: string | null;
  podcast_locked: boolean | null;
  podcast_locked_owner: string | null;
  podcast_medium: string | null;
  extra_namespaces: Record<string, string>;
  feed_cache_xml: string | null;
  feed_cache_etag: string | null;
}

export async function getPodcastRow(q: Queryable, podcastId: string): Promise<PodcastRow | null> {
  return maybeOne<PodcastRow>(q, `SELECT * FROM podcasts WHERE id = $1`, [podcastId]);
}

export async function getPodcastBySlug(q: Queryable, slug: string): Promise<PodcastRow | null> {
  return maybeOne<PodcastRow>(q, `SELECT * FROM podcasts WHERE slug = $1`, [slug]);
}

interface TagRow {
  episode_id: string | null;
  ns_prefix: string;
  name: string;
  attributes: Record<string, string>;
  value: string | null;
  cdata: boolean;
  children: XmlNode[] | null;
}

export async function loadFeed(q: Queryable, podcastId: string): Promise<Feed | null> {
  const p = await getPodcastRow(q, podcastId);
  if (!p) return null;

  const { rows: eps } = await q.query<Record<string, unknown> & { id: string }>(
    `SELECT * FROM episodes WHERE podcast_id = $1 ORDER BY pub_date DESC NULLS LAST, sort_index`,
    [podcastId],
  );
  const { rows: tags } = await q.query<TagRow>(
    `SELECT episode_id, ns_prefix, name, attributes, value, cdata, children
       FROM tag_elements WHERE podcast_id = $1 ORDER BY episode_id NULLS FIRST, sort_order`,
    [podcastId],
  );
  const toNode = (t: TagRow): XmlNode => ({
    name: t.ns_prefix ? `${t.ns_prefix}:${t.name}` : t.name,
    attrs: t.attributes,
    text: t.value ?? '',
    cdata: t.cdata,
    children: t.children ?? [],
  });
  const byEpisode = new Map<string | null, XmlNode[]>();
  for (const t of tags) {
    const list = byEpisode.get(t.episode_id) ?? [];
    list.push(toNode(t));
    byEpisode.set(t.episode_id, list);
  }

  const channel: Channel = {
    title: p.title,
    description: p.description,
    link: p.link,
    language: p.language,
    copyright: p.copyright,
    imageUrl: p.image_url,
    itunesAuthor: p.itunes_author,
    itunesType: p.itunes_type,
    itunesExplicit: p.itunes_explicit,
    itunesOwnerName: p.itunes_owner_name,
    itunesOwnerEmail: p.itunes_owner_email,
    itunesCategories: p.itunes_categories ?? [],
    itunesBlock: p.itunes_block,
    itunesComplete: p.itunes_complete,
    itunesNewFeedUrl: p.itunes_new_feed_url,
    podcastGuid: p.podcast_guid,
    podcastLocked: p.podcast_locked,
    podcastLockedOwner: p.podcast_locked_owner,
    podcastMedium: p.podcast_medium,
    extra: byEpisode.get(null) ?? [],
  };

  const items: Item[] = eps.map((e) => ({
    guid: e.guid as string,
    guidIsPermalink: e.guid_is_permalink as boolean | null,
    status: e.status as EpisodeStatus,
    pubDate: (e.pub_date as Date | null) ?? null,
    title: e.title as string,
    description: e.description as string | null,
    link: e.link as string | null,
    enclosureUrl: e.enclosure_url as string | null,
    enclosureLength: e.enclosure_length as number | null,
    enclosureType: e.enclosure_type as string | null,
    itunesTitle: e.itunes_title as string | null,
    itunesDuration: e.itunes_duration as number | null,
    itunesEpisode: e.itunes_episode as number | null,
    itunesSeason: e.itunes_season as number | null,
    itunesEpisodeType: e.itunes_episode_type as EpisodeType | null,
    itunesExplicit: e.itunes_explicit as boolean | null,
    itunesImageUrl: e.itunes_image_url as string | null,
    itunesBlock: e.itunes_block as boolean,
    extra: byEpisode.get(e.id) ?? [],
  }));

  return { channel, items, namespaces: p.extra_namespaces ?? {} };
}

// ───────────── Stats prefixes ─────────────

export interface PrefixConfig {
  settings: PrefixSetting[];
  prefixAlternateEnclosures: boolean;
}

export async function getPrefixConfig(q: Queryable, podcastId: string): Promise<PrefixConfig> {
  const { rows } = await q.query<{
    service_key: string;
    enabled: boolean;
    param_value: string | null;
    position: number;
    prefix_alternate_enclosures: boolean;
  }>(
    `SELECT service_key, enabled, param_value, position, prefix_alternate_enclosures
       FROM podcast_prefixes WHERE podcast_id = $1 ORDER BY position`,
    [podcastId],
  );
  return {
    settings: rows.map((r) => ({
      serviceKey: r.service_key,
      enabled: r.enabled,
      paramValue: r.param_value,
      position: r.position,
    })),
    prefixAlternateEnclosures: rows.some((r) => r.prefix_alternate_enclosures),
  };
}

/** Validates (throws PrefixError) before replacing the podcast's settings. */
export async function setPrefixConfig(q: Queryable, podcastId: string, cfg: PrefixConfig): Promise<void> {
  buildPrefixChain(cfg.settings);
  const seen = new Set<string>();
  for (const s of cfg.settings) {
    if (s.serviceKey !== 'custom' && seen.has(s.serviceKey)) throw new Error(`Duplicate prefix service ${s.serviceKey}`);
    seen.add(s.serviceKey);
  }
  await q.query(`DELETE FROM podcast_prefixes WHERE podcast_id = $1`, [podcastId]);
  if (cfg.settings.length) {
    await q.query(
      `INSERT INTO podcast_prefixes (podcast_id, service_key, enabled, param_value, position, prefix_alternate_enclosures)
       SELECT $1, x.service_key, x.enabled, x.param_value, x.position, $3
         FROM jsonb_to_recordset($2::jsonb) AS x(service_key text, enabled boolean, param_value text, position int)`,
      [
        podcastId,
        JSON.stringify(
          cfg.settings.map((s, i) => ({
            service_key: s.serviceKey,
            enabled: s.enabled,
            param_value: s.paramValue?.trim() || null,
            position: Number.isInteger(s.position) ? s.position : i,
          })),
        ),
        cfg.prefixAlternateEnclosures,
      ],
    );
  }
  await invalidateFeedCache(q, podcastId);
}

export async function invalidateFeedCache(q: Queryable, podcastId: string): Promise<void> {
  await q.query(`UPDATE podcasts SET feed_cache_xml = NULL, feed_cache_etag = NULL, updated_at = now() WHERE id = $1`, [
    podcastId,
  ]);
}
