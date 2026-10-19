/**
 * Creating, editing and deleting episodes from the dashboard.
 *
 * The typed columns hold the fields everyone edits; transcripts and chapters
 * get their own fields; every other tag (podcast:person, soundbite, value,
 * location, alternateEnclosure, anything from an import) is editable as XML
 * under "Other tags", so nothing the feed supports is out of reach.
 *
 * Publishing: a draft is never in the feed. Saving with "publish" puts it in
 * the feed now, or at its date if that's in the future (scheduled). Podping
 * announces an episode when it appears (the Podping worker does this for
 * new and scheduled episodes) and when a public episode changes.
 */
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { maybeOne, one, type Queryable } from '../db/db.js';
import { invalidateFeedCache, isUuid } from '../db/podcasts.js';
import { parseDuration } from '../feed/parser.js';
import type { XmlNode } from '../feed/types.js';
import { ownMediaPaths } from '../media/prune.js';
import { peopleFromTags, peopleToTags, type Person } from './people.js';
import { locationsFromTags, locationsToTags, type Place } from './location.js';
import { queuePing } from '../podping/podping.js';
import {
  addNamespaces,
  bool,
  fileRef,
  httpUrl,
  insertTags,
  node,
  oneOf,
  optionalBool,
  parseTagsXml,
  PublishError,
  tagsToXml,
  text,
  wholeNumber,
} from './fields.js';

export type Status = 'draft' | 'scheduled' | 'published';
const EPISODE_TYPES = ['full', 'trailer', 'bonus'] as const;
const TRANSCRIPT_TYPES = ['text/vtt', 'application/x-subrip', 'application/srt', 'text/html', 'application/json', 'text/plain'] as const;

/** Item tags with their own field in the editor. */
const MANAGED = new Map<string, string>([
  ['title', 'Title'], ['description', 'Description'], ['link', 'Episode web page'], ['guid', 'set automatically'],
  ['pubDate', 'Publishing'], ['enclosure', 'Audio'], ['itunes:title', 'Title for Apple'], ['itunes:image', 'Episode art'],
  ['itunes:duration', 'Length'], ['itunes:episode', 'Episode number'], ['itunes:season', 'Season'],
  ['itunes:episodeType', 'Type'], ['itunes:explicit', 'Explicit'], ['itunes:block', 'Hide from Apple Podcasts'],
  ['podcast:transcript', 'Transcripts'], ['podcast:chapters', 'Chapters'], ['podcast:person', 'People'], ['podcast:location', 'Locations'],
]);
const OWN_FIELD = new Set(['podcast:transcript', 'podcast:chapters', 'podcast:person', 'podcast:location']);

export interface Transcript {
  url: string;
  type: string;
  language: string | null;
  rel: string | null;
}

export interface EpisodeView {
  id: string;
  guid: string;
  status: Status;
  inFeed: boolean;
  pubDate: string | null;
  title: string;
  description: string | null;
  link: string | null;
  enclosure: { url: string; length: number | null; type: string | null; mediaId: string | null; name: string | null } | null;
  itunesTitle: string | null;
  duration: number | null;
  season: number | null;
  episode: number | null;
  episodeType: (typeof EPISODE_TYPES)[number] | null;
  explicit: boolean | null;
  imageUrl: string | null;
  block: boolean;
  transcripts: Transcript[];
  chapters: { url: string } | null;
  /** This episode's own people. Empty = the show's people apply. */
  people: Person[];
  locations: Place[];
  otherTags: string;
  updatedAt: string;
}

interface Row {
  id: string;
  guid: string;
  status: Status;
  pub_date: Date | null;
  title: string;
  description: string | null;
  link: string | null;
  enclosure_media_id: string | null;
  enclosure_url: string | null;
  enclosure_length: number | null;
  enclosure_type: string | null;
  itunes_title: string | null;
  itunes_duration: number | null;
  itunes_episode: number | null;
  itunes_season: number | null;
  itunes_episode_type: EpisodeView['episodeType'];
  itunes_explicit: boolean | null;
  itunes_image_url: string | null;
  itunes_block: boolean;
  announced_at: Date | null;
  updated_at: Date;
}

interface TagRow {
  ns_prefix: string;
  name: string;
  attributes: Record<string, string>;
  value: string | null;
  cdata: boolean;
  children: XmlNode[] | null;
}

const isPublic = (status: Status, pubDate: Date | null, now = Date.now()) =>
  status !== 'draft' && (!pubDate || pubDate.getTime() <= now);

async function loadRow(q: Queryable, podcastId: string, episodeId: string): Promise<Row> {
  const r = isUuid(episodeId)
    ? await maybeOne<Row>(q, `SELECT * FROM episodes WHERE id = $1 AND podcast_id = $2`, [episodeId, podcastId])
    : null;
  if (!r) throw new PublishError('Episode not found', 404);
  return r;
}

async function loadTags(q: Queryable, episodeId: string): Promise<XmlNode[]> {
  const { rows } = await q.query<TagRow>(
    `SELECT ns_prefix, name, attributes, value, cdata, children FROM tag_elements WHERE episode_id = $1 ORDER BY sort_order`,
    [episodeId],
  );
  return rows.map((t) => ({
    name: t.ns_prefix ? `${t.ns_prefix}:${t.name}` : t.name,
    attrs: t.attributes,
    text: t.value ?? '',
    cdata: t.cdata,
    children: t.children ?? [],
  }));
}

function view(r: Row, tags: XmlNode[], mediaName: string | null): EpisodeView {
  const chapters = tags.find((t) => t.name === 'podcast:chapters');
  return {
    id: r.id,
    guid: r.guid,
    status: r.status,
    inFeed: isPublic(r.status, r.pub_date),
    pubDate: r.pub_date ? new Date(r.pub_date).toISOString() : null,
    title: r.title,
    description: r.description,
    link: r.link,
    enclosure: r.enclosure_url
      ? {
          url: r.enclosure_url,
          length: r.enclosure_length === null ? null : Number(r.enclosure_length),
          type: r.enclosure_type,
          mediaId: r.enclosure_media_id,
          name: mediaName,
        }
      : null,
    itunesTitle: r.itunes_title,
    duration: r.itunes_duration,
    season: r.itunes_season,
    episode: r.itunes_episode,
    episodeType: r.itunes_episode_type,
    explicit: r.itunes_explicit,
    imageUrl: r.itunes_image_url,
    block: r.itunes_block,
    transcripts: tags
      .filter((t) => t.name === 'podcast:transcript' && t.attrs.url)
      .map((t) => ({ url: t.attrs.url!, type: t.attrs.type ?? 'text/plain', language: t.attrs.language ?? null, rel: t.attrs.rel ?? null })),
    chapters: chapters?.attrs.url ? { url: chapters.attrs.url } : null,
    people: peopleFromTags(tags),
    locations: locationsFromTags(tags),
    otherTags: tagsToXml(tags.filter((t) => !MANAGED.has(t.name))),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function getEpisode(q: Queryable, podcastId: string, episodeId: string): Promise<EpisodeView> {
  const r = await loadRow(q, podcastId, episodeId);
  const name = r.enclosure_media_id
    ? (await maybeOne<{ original_name: string | null }>(q, `SELECT original_name FROM media_files WHERE id = $1`, [r.enclosure_media_id]))?.original_name ?? null
    : null;
  return view(r, await loadTags(q, r.id), name);
}

// ───────────── saving ─────────────

export interface EpisodeInput {
  title?: unknown;
  description?: unknown;
  link?: unknown;
  status?: unknown;
  pubDate?: unknown;
  enclosure?: unknown;
  itunesTitle?: unknown;
  duration?: unknown;
  season?: unknown;
  episode?: unknown;
  episodeType?: unknown;
  explicit?: unknown;
  image?: unknown;
  block?: unknown;
  transcripts?: unknown;
  chapters?: unknown;
  people?: unknown;
  locations?: unknown;
  otherTags?: unknown;
}

interface Draft {
  status: Status;
  pubDate: Date | null;
  title: string;
  description: string | null;
  link: string | null;
  enclosureMediaId: string | null;
  enclosureUrl: string | null;
  enclosureLength: number | null;
  enclosureType: string | null;
  itunesTitle: string | null;
  duration: number | null;
  season: number | null;
  episode: number | null;
  episodeType: EpisodeView['episodeType'];
  explicit: boolean | null;
  imageUrl: string | null;
  block: boolean;
  managedTags: XmlNode[]; // transcripts, chapters, people
  otherTags: XmlNode[];
  /** Tags in their stored order, kept as-is until a tag field changes. */
  storedTags: XmlNode[] | null;
}

function fromRow(r: Row, tags: XmlNode[]): Draft {
  return {
    status: r.status,
    pubDate: r.pub_date ? new Date(r.pub_date) : null,
    title: r.title,
    description: r.description,
    link: r.link,
    enclosureMediaId: r.enclosure_media_id,
    enclosureUrl: r.enclosure_url,
    enclosureLength: r.enclosure_length === null ? null : Number(r.enclosure_length),
    enclosureType: r.enclosure_type,
    itunesTitle: r.itunes_title,
    duration: r.itunes_duration,
    season: r.itunes_season,
    episode: r.itunes_episode,
    episodeType: r.itunes_episode_type,
    explicit: r.itunes_explicit,
    imageUrl: r.itunes_image_url,
    block: r.itunes_block,
    managedTags: tags.filter((t) => OWN_FIELD.has(t.name)),
    otherTags: tags.filter((t) => !MANAGED.has(t.name)),
    storedTags: tags,
  };
}

function date(v: unknown, field: string): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new PublishError(`${field} must be a date and time, e.g. 2026-11-03T06:00:00-05:00`);
  return d;
}

async function applyInput(
  q: Queryable,
  config: Config,
  podcastId: string,
  namespaces: Record<string, string>,
  d: Draft,
  input: EpisodeInput,
  creating: boolean,
  now: Date,
): Promise<{ draft: Draft; namespaces: Record<string, string> }> {
  const next: Draft = { ...d };
  if ([input.transcripts, input.chapters, input.people, input.locations, input.otherTags].some((v) => v !== undefined)) next.storedTags = null;
  let newNs: Record<string, string> = {};

  if (input.title !== undefined || creating) next.title = text(input.title, 'Title', { required: true, max: 1000 })!;
  if (input.description !== undefined) next.description = text(input.description, 'Description', { max: 200_000 });
  if (input.link !== undefined) next.link = httpUrl(input.link, 'Episode web page');
  if (input.itunesTitle !== undefined) next.itunesTitle = text(input.itunesTitle, 'Title for Apple', { max: 1000 });
  if (input.season !== undefined) next.season = wholeNumber(input.season, 'Season', 100_000);
  if (input.episode !== undefined) next.episode = wholeNumber(input.episode, 'Episode number', 1_000_000);
  if (input.episodeType !== undefined) next.episodeType = oneOf(input.episodeType, 'Type', EPISODE_TYPES);
  if (input.explicit !== undefined) next.explicit = optionalBool(input.explicit, 'Explicit');
  if (input.block !== undefined) next.block = bool(input.block, 'Hide from Apple Podcasts');

  if (input.enclosure !== undefined) {
    const e = input.enclosure as { type?: unknown; length?: unknown } | null;
    const ref = await fileRef(q, config, podcastId, input.enclosure, 'Audio', ['audio', 'video']);
    if (!ref) {
      next.enclosureMediaId = next.enclosureUrl = next.enclosureType = null;
      next.enclosureLength = null;
    } else if (ref.media) {
      next.enclosureMediaId = ref.media.id;
      next.enclosureUrl = ref.url;
      next.enclosureLength = ref.media.bytes;
      next.enclosureType = ref.media.mimeType;
      // A new file brings its own running time unless one is given in the same save.
      if (input.duration === undefined && ref.media.duration) next.duration = ref.media.duration;
    } else {
      next.enclosureMediaId = null;
      next.enclosureUrl = ref.url;
      const type = e && typeof e === 'object' ? e.type : undefined;
      if (type !== undefined && type !== null && (typeof type !== 'string' || !/^(audio|video)\/[\w.+-]+$/.test(type))) {
        throw new PublishError('Audio type must be an audio or video type, such as audio/mpeg');
      }
      next.enclosureType = (type as string | undefined) ?? (/\.(m4a|mp4a)$/i.test(ref.url) ? 'audio/x-m4a' : /\.mp4$/i.test(ref.url) ? 'video/mp4' : 'audio/mpeg');
      next.enclosureLength = e && typeof e === 'object' ? wholeNumber(e.length, 'Audio file size', Number.MAX_SAFE_INTEGER) : null;
    }
  }
  if (input.duration !== undefined) {
    if (input.duration === null || input.duration === '') next.duration = null;
    else {
      const n = typeof input.duration === 'number' ? input.duration : parseDuration(String(input.duration));
      if (n === null || !Number.isFinite(n) || n < 0) throw new PublishError('Length must be like 45:30 or 1:02:03');
      next.duration = Math.round(n);
    }
  }
  if (input.image !== undefined) {
    next.imageUrl = (await fileRef(q, config, podcastId, input.image, 'Episode art', ['image']))?.url ?? null;
  }

  if ([input.transcripts, input.chapters, input.people, input.locations].some((v) => v !== undefined)) {
    const old = next.managedTags;
    let transcripts = old.filter((t) => t.name === 'podcast:transcript');
    let chapters = old.filter((t) => t.name === 'podcast:chapters');
    let people = old.filter((t) => t.name === 'podcast:person');
    let locations = old.filter((t) => t.name === 'podcast:location');
    if (input.people !== undefined) people = await peopleToTags(q, config, podcastId, input.people);
    if (input.locations !== undefined) locations = locationsToTags(input.locations);
    if (input.transcripts !== undefined) {
      const list = input.transcripts === null ? [] : input.transcripts;
      if (!Array.isArray(list)) throw new PublishError('Transcripts must be a list');
      if (list.length > 10) throw new PublishError('At most 10 transcripts');
      transcripts = [];
      for (const [i, t] of list.entries()) {
        const o = (t ?? {}) as { type?: unknown; language?: unknown; rel?: unknown };
        const ref = await fileRef(q, config, podcastId, t, `Transcript ${i + 1}`, ['transcript']);
        if (!ref) throw new PublishError(`Transcript ${i + 1} needs a file or web address`);
        const type = oneOf(o.type ?? ref.media?.mimeType ?? null, `Transcript ${i + 1} type`, TRANSCRIPT_TYPES);
        if (!type) throw new PublishError(`Transcript ${i + 1} needs a type (VTT, SRT, HTML, JSON or text)`);
        const attrs: Record<string, string> = { url: ref.url, type };
        const lang = text(o.language, `Transcript ${i + 1} language`, { max: 35 });
        if (lang) {
          if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new PublishError(`Transcript ${i + 1} language must be a code like en or en-US`);
          attrs.language = lang;
        }
        if (o.rel === 'captions') attrs.rel = 'captions';
        transcripts.push(node('podcast:transcript', attrs));
      }
    }
    if (input.chapters !== undefined) {
      const ref = await fileRef(q, config, podcastId, input.chapters, 'Chapters', ['chapters', 'transcript']);
      chapters = ref ? [node('podcast:chapters', { url: ref.url, type: 'application/json+chapters' })] : [];
    }
    next.managedTags = [...transcripts, ...chapters, ...people, ...locations];
  }

  if (input.otherTags !== undefined) {
    const parsed = parseTagsXml(input.otherTags, namespaces, MANAGED);
    next.otherTags = parsed.nodes;
    newNs = parsed.namespaces;
  }

  // Publishing state.
  if (input.status !== undefined || creating) {
    next.status = oneOf(input.status ?? 'draft', 'Status', ['draft', 'published', 'scheduled'] as const)!;
  }
  if (input.pubDate !== undefined) next.pubDate = date(input.pubDate, 'Publish date');
  if (next.status !== 'draft') {
    next.pubDate ??= now;
    next.status = next.pubDate.getTime() > now.getTime() ? 'scheduled' : 'published';
    if (!next.enclosureUrl) throw new PublishError('Add the audio before publishing');
  }
  return { draft: next, namespaces: newNs };
}

async function showContext(q: Queryable, podcastId: string) {
  const p = await one<{ slug: string; status: string; extra_namespaces: Record<string, string> | null }>(
    q,
    `SELECT slug, status, extra_namespaces FROM podcasts WHERE id = $1 FOR UPDATE`,
    [podcastId],
  );
  if (p.status !== 'active') throw new PublishError('This show is still importing. Wait for the import to finish before editing.', 409);
  return { slug: p.slug, namespaces: p.extra_namespaces ?? {} };
}

async function write(q: Queryable, podcastId: string, id: string, d: Draft, announcedAt: Date | null | 'keep') {
  await q.query(
    `UPDATE episodes SET status = $3, pub_date = $4, title = $5, description = $6, link = $7,
            enclosure_media_id = $8, enclosure_url = $9, enclosure_length = $10, enclosure_type = $11,
            itunes_title = $12, itunes_duration = $13, itunes_episode = $14, itunes_season = $15,
            itunes_episode_type = $16, itunes_explicit = $17, itunes_image_url = $18, itunes_block = $19,
            announced_at = CASE WHEN $20 THEN announced_at ELSE $21::timestamptz END, updated_at = now()
      WHERE id = $1 AND podcast_id = $2`,
    [
      id, podcastId, d.status, d.pubDate?.toISOString() ?? null, d.title, d.description, d.link,
      d.enclosureMediaId, d.enclosureUrl, d.enclosureLength, d.enclosureType,
      d.itunesTitle, d.duration, d.episode, d.season, d.episodeType, d.explicit, d.imageUrl, d.block,
      announcedAt === 'keep', announcedAt === 'keep' ? null : announcedAt?.toISOString() ?? null,
    ],
  );
  await q.query(`DELETE FROM tag_elements WHERE episode_id = $1`, [id]);
}

/** Every file of this show an episode points at (for cleaning up files it stops using). */
function filesOf(slug: string, d: Pick<Draft, 'enclosureUrl' | 'imageUrl' | 'managedTags' | 'otherTags' | 'description'>): string[] {
  const urls: (string | null)[] = [d.enclosureUrl, d.imageUrl];
  const walk = (n: XmlNode) => {
    urls.push(...Object.values(n.attrs), n.text);
    n.children.forEach(walk);
  };
  [...d.managedTags, ...d.otherTags].forEach(walk);
  return [...ownMediaPaths(slug, urls), ...ownMediaPaths(slug, (d.description ?? '').split(/["'\s]/))];
}

export async function createEpisode(
  q: Queryable,
  config: Config,
  podcastId: string,
  input: EpisodeInput,
  now = new Date(),
): Promise<string> {
  const ctx = await showContext(q, podcastId);
  const blank: Draft = {
    status: 'draft', pubDate: null, title: '', description: null, link: null,
    enclosureMediaId: null, enclosureUrl: null, enclosureLength: null, enclosureType: null,
    itunesTitle: null, duration: null, season: null, episode: null, episodeType: null, explicit: null,
    imageUrl: null, block: false, managedTags: [], otherTags: [], storedTags: null,
  };
  const { draft, namespaces } = await applyInput(q, config, podcastId, ctx.namespaces, blank, input, true, now);
  const { id } = await one<{ id: string }>(
    q,
    `INSERT INTO episodes (podcast_id, guid, guid_is_permalink, title, sort_index) VALUES ($1, $2, false, $3, -1) RETURNING id`,
    [podcastId, randomUUID(), draft.title],
  );
  // announced_at stays empty: the Podping worker announces the episode when it's due.
  await write(q, podcastId, id, draft, null);
  await insertTags(q, podcastId, id, draft.storedTags ?? [...draft.managedTags, ...draft.otherTags], { ...ctx.namespaces, ...namespaces });
  await addNamespaces(q, podcastId, namespaces);
  await invalidateFeedCache(q, podcastId);
  return id;
}

/** Returns the media paths the episode stopped using, for the caller to prune after commit. */
export async function updateEpisode(
  q: Queryable,
  config: Config,
  podcastId: string,
  episodeId: string,
  input: EpisodeInput,
  now = new Date(),
): Promise<{ dropped: string[] }> {
  const ctx = await showContext(q, podcastId);
  const row = await loadRow(q, podcastId, episodeId);
  const before = fromRow(row, await loadTags(q, row.id));
  const { draft, namespaces } = await applyInput(q, config, podcastId, ctx.namespaces, before, input, false, now);

  const wasPublic = isPublic(before.status, before.pubDate, now.getTime());
  const nowPublic = isPublic(draft.status, draft.pubDate, now.getTime());
  // Not in the feed (draft or future date): announce again when it appears.
  await write(q, podcastId, row.id, draft, nowPublic ? 'keep' : null);
  await insertTags(q, podcastId, row.id, draft.storedTags ?? [...draft.managedTags, ...draft.otherTags], { ...ctx.namespaces, ...namespaces });
  await addNamespaces(q, podcastId, namespaces);
  await invalidateFeedCache(q, podcastId);
  // A public episode changed or left the feed. (One that just appeared is announced by the worker.)
  if ((wasPublic && nowPublic && row.announced_at) || (wasPublic && !nowPublic)) await queuePing(q, config, podcastId, 'update');

  const keep = new Set(filesOf(ctx.slug, draft));
  return { dropped: filesOf(ctx.slug, before).filter((p) => !keep.has(p)) };
}

export async function deleteEpisode(q: Queryable, config: Config, podcastId: string, episodeId: string): Promise<{ dropped: string[] }> {
  const ctx = await showContext(q, podcastId);
  const row = await loadRow(q, podcastId, episodeId);
  const before = fromRow(row, await loadTags(q, row.id));
  await q.query(`DELETE FROM episodes WHERE id = $1`, [row.id]);
  await invalidateFeedCache(q, podcastId);
  if (isPublic(before.status, before.pubDate)) await queuePing(q, config, podcastId, 'update');
  return { dropped: filesOf(ctx.slug, before) };
}

/** The list on the Episodes tab. */
export async function listEpisodes(q: Queryable, podcastId: string) {
  const { rows } = await q.query<Row & { has_transcript: boolean; has_chapters: boolean }>(
    `SELECT e.*, EXISTS (SELECT 1 FROM tag_elements t WHERE t.episode_id = e.id AND t.ns_prefix = 'podcast' AND t.name = 'transcript') AS has_transcript,
            EXISTS (SELECT 1 FROM tag_elements t WHERE t.episode_id = e.id AND t.ns_prefix = 'podcast' AND t.name = 'chapters') AS has_chapters
       FROM episodes e WHERE e.podcast_id = $1
      ORDER BY (e.status = 'draft') DESC, e.pub_date DESC NULLS FIRST, e.sort_index, e.created_at DESC`,
    [podcastId],
  );
  const now = Date.now();
  return rows.map((e) => ({
    id: e.id,
    guid: e.guid,
    title: e.title,
    status: e.status,
    inFeed: isPublic(e.status, e.pub_date, now),
    pub_date: e.pub_date,
    enclosure_url: e.enclosure_url,
    enclosure_length: e.enclosure_length,
    enclosure_type: e.enclosure_type,
    itunes_duration: e.itunes_duration,
    itunes_episode: e.itunes_episode,
    itunes_season: e.itunes_season,
    itunes_episode_type: e.itunes_episode_type,
    imageUrl: e.itunes_image_url,
    hasTranscript: e.has_transcript,
    hasChapters: e.has_chapters,
  }));
}
