/**
 * <podcast:liveItem> management. Live items are stored in the generic tag
 * store (tag_elements) exactly like imported ones, so editing a live item that
 * came from an imported feed keeps any extra tags inside it (chat, value,
 * alternateEnclosure…) untouched — only the fields managed here change.
 *
 * PodSovereign doesn't stream: the stream URL points at your own streaming server
 * (Icecast, a YouTube or Twitch live page, etc.).
 */
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { maybeOne, one, type Queryable } from '../db/db.js';
import { invalidateFeedCache } from '../db/podcasts.js';
import type { XmlNode } from '../feed/types.js';
import { queuePing } from '../podping/podping.js';

export type LiveStatus = 'pending' | 'live' | 'ended';
export const LIVE_STATUSES: readonly LiveStatus[] = ['pending', 'live', 'ended'];

export interface ContentLink {
  href: string;
  text: string;
}

export interface LiveItem {
  id: string;
  status: LiveStatus;
  start: string | null;
  end: string | null;
  title: string;
  description: string | null;
  guid: string;
  streamUrl: string | null;
  streamType: string | null;
  imageUrl: string | null;
  contentLinks: ContentLink[];
  /** Names of other tags kept inside this live item (from an import). */
  otherTags: string[];
}

export interface LiveInput {
  title?: unknown;
  description?: unknown;
  start?: unknown;
  end?: unknown;
  streamUrl?: unknown;
  streamType?: unknown;
  imageUrl?: unknown;
  contentLinks?: unknown;
}

export class LiveError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MANAGED = new Set(['title', 'description', 'guid', 'enclosure', 'itunes:image', 'podcast:contentLink']);

const node = (name: string, attrs: Record<string, string> = {}, text = '', cdata = false): XmlNode => ({
  name,
  attrs,
  text,
  cdata,
  children: [],
});

// ───────────── XmlNode ⇄ LiveItem ─────────────

export function toLiveItem(id: string, attrs: Record<string, string>, children: XmlNode[]): LiveItem {
  const child = (n: string) => children.find((c) => c.name === n);
  const enc = child('enclosure');
  const status = LIVE_STATUSES.includes(attrs.status as LiveStatus) ? (attrs.status as LiveStatus) : 'pending';
  return {
    id,
    status,
    start: attrs.start ?? null,
    end: attrs.end ?? null,
    title: child('title')?.text ?? '',
    description: child('description')?.text || null,
    guid: child('guid')?.text ?? '',
    streamUrl: enc?.attrs.url ?? null,
    streamType: enc?.attrs.type ?? null,
    imageUrl: child('itunes:image')?.attrs.href ?? null,
    contentLinks: children
      .filter((c) => c.name === 'podcast:contentLink')
      .map((c) => ({ href: c.attrs.href ?? '', text: c.text })),
    otherTags: children.filter((c) => !MANAGED.has(c.name)).map((c) => c.name),
  };
}

/** Rebuild the children list: managed fields from `item`, everything else kept in place. */
function applyToChildren(item: LiveItem, children: XmlNode[]): XmlNode[] {
  const managed: XmlNode[] = [node('title', {}, item.title)];
  if (item.description) managed.push(node('description', {}, item.description, /[<>&]/.test(item.description)));
  managed.push(node('guid', { isPermaLink: 'false' }, item.guid));
  if (item.streamUrl) managed.push(node('enclosure', { url: item.streamUrl, type: item.streamType ?? 'audio/mpeg', length: '0' }));
  if (item.imageUrl) managed.push(node('itunes:image', { href: item.imageUrl }));
  for (const l of item.contentLinks) managed.push(node('podcast:contentLink', { href: l.href }, l.text));
  // Keep any guid attribute the source used (e.g. isPermaLink="true").
  const oldGuid = children.find((c) => c.name === 'guid');
  if (oldGuid) managed[managed.findIndex((n) => n.name === 'guid')]!.attrs = { ...oldGuid.attrs };
  return [...managed, ...children.filter((c) => !MANAGED.has(c.name))];
}

function attrsFor(item: LiveItem, old: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...old, status: item.status };
  if (item.start) out.start = item.start;
  else delete out.start;
  if (item.end) out.end = item.end;
  else delete out.end;
  return out;
}

// ───────────── Validation ─────────────

function isoDate(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new LiveError(`${field} must be a date and time, e.g. 2026-11-01T19:00:00-04:00`);
  // Keep the podcaster's own offset if they gave one; it reads better in the feed.
  return /T\d\d:\d\d/.test(v) && /(Z|[+-]\d\d:?\d\d)$/.test(v) ? v : new Date(v).toISOString();
}

function httpUrl(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new LiveError(`${field} must be a URL`);
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    return u.toString();
  } catch {
    throw new LiveError(`${field} must be a full http(s) URL`);
  }
}

function applyInput(item: LiveItem, input: LiveInput, creating: boolean): LiveItem {
  const next = { ...item };
  if (input.title !== undefined || creating) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw new LiveError('Title is required');
    next.title = input.title.trim().slice(0, 500);
  }
  if (input.description !== undefined) {
    next.description = typeof input.description === 'string' && input.description.trim() ? input.description : null;
  }
  if (input.start !== undefined || creating) {
    next.start = isoDate(input.start, 'Start');
    if (!next.start) throw new LiveError('Start time is required');
  }
  if (input.end !== undefined) next.end = isoDate(input.end, 'End');
  if (input.streamUrl !== undefined || creating) {
    next.streamUrl = httpUrl(input.streamUrl, 'Stream URL');
    if (!next.streamUrl) throw new LiveError('Stream URL is required (the address of your live audio or video stream)');
  }
  if (input.streamType !== undefined) {
    if (input.streamType !== null && (typeof input.streamType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.streamType))) {
      throw new LiveError('Stream type must be a MIME type such as audio/mpeg');
    }
    next.streamType = input.streamType as string | null;
  }
  if (input.imageUrl !== undefined) next.imageUrl = httpUrl(input.imageUrl, 'Image URL');
  if (input.contentLinks !== undefined) {
    if (!Array.isArray(input.contentLinks)) throw new LiveError('contentLinks must be a list');
    next.contentLinks = input.contentLinks.slice(0, 10).map((l, i) => {
      const o = (l ?? {}) as { href?: unknown; text?: unknown };
      const href = httpUrl(o.href, `Link ${i + 1}`);
      if (!href) throw new LiveError(`Link ${i + 1} needs a URL`);
      return { href, text: typeof o.text === 'string' && o.text.trim() ? o.text.trim() : 'Listen live' };
    });
  }
  if (next.start && next.end && Date.parse(next.end) < Date.parse(next.start)) throw new LiveError('End must be after start');
  return next;
}

// ───────────── Storage ─────────────

interface Row {
  id: string;
  attributes: Record<string, string>;
  children: XmlNode[] | null;
}

const SELECT = `SELECT id, attributes, children FROM tag_elements
  WHERE podcast_id = $1 AND episode_id IS NULL AND ns_prefix = 'podcast' AND name = 'liveItem'`;

export async function listLiveItems(q: Queryable, podcastId: string): Promise<LiveItem[]> {
  const { rows } = await q.query<Row>(`${SELECT} ORDER BY sort_order`, [podcastId]);
  return rows.map((r) => toLiveItem(r.id, r.attributes, r.children ?? []));
}

async function getRow(q: Queryable, podcastId: string, liveId: string): Promise<Row> {
  const row = /^[0-9a-f-]{36}$/i.test(liveId) ? await maybeOne<Row>(q, `${SELECT} AND id = $2`, [podcastId, liveId]) : null;
  if (!row) throw new LiveError('Live item not found', 404);
  return row;
}

async function save(q: Queryable, podcastId: string, id: string, item: LiveItem, old: Row) {
  await q.query(`UPDATE tag_elements SET attributes = $2, children = $3 WHERE id = $1`, [
    id,
    JSON.stringify(attrsFor(item, old.attributes)),
    JSON.stringify(applyToChildren(item, old.children ?? [])),
  ]);
  await invalidateFeedCache(q, podcastId);
}

export async function createLiveItem(q: Queryable, podcastId: string, input: LiveInput): Promise<LiveItem> {
  const blank: LiveItem = {
    id: '',
    status: 'pending',
    start: null,
    end: null,
    title: '',
    description: null,
    guid: randomUUID(),
    streamUrl: null,
    streamType: 'audio/mpeg',
    imageUrl: null,
    contentLinks: [],
    otherTags: [],
  };
  const item = applyInput(blank, input, true);
  const r = await one<{ id: string }>(
    q,
    `INSERT INTO tag_elements (podcast_id, episode_id, ns_uri, ns_prefix, name, attributes, value, cdata, children, sort_order)
     VALUES ($1, NULL, 'https://podcastindex.org/namespace/1.0', 'podcast', 'liveItem', $2, NULL, false, $3,
             (SELECT COALESCE(max(sort_order), -1) + 1 FROM tag_elements WHERE podcast_id = $1 AND episode_id IS NULL))
     RETURNING id`,
    [podcastId, JSON.stringify(attrsFor(item, {})), JSON.stringify(applyToChildren(item, []))],
  );
  await invalidateFeedCache(q, podcastId);
  return { ...item, id: r.id };
}

export async function updateLiveItem(q: Queryable, podcastId: string, liveId: string, input: LiveInput): Promise<LiveItem> {
  const row = await getRow(q, podcastId, liveId);
  const item = applyInput(toLiveItem(row.id, row.attributes, row.children ?? []), input, false);
  await save(q, podcastId, row.id, item, row);
  return toLiveItem(row.id, attrsFor(item, row.attributes), applyToChildren(item, row.children ?? []));
}

/**
 * Change status. Going live sends a Podping "live"; ending (from live) sends
 * "liveEnd" and stamps the end time if it's missing or still in the future.
 */
export async function setLiveStatus(
  q: Queryable,
  config: Config,
  podcastId: string,
  liveId: string,
  status: unknown,
  now = new Date(),
): Promise<LiveItem> {
  if (!LIVE_STATUSES.includes(status as LiveStatus)) throw new LiveError('Status must be pending, live or ended');
  const row = await getRow(q, podcastId, liveId);
  const before = toLiveItem(row.id, row.attributes, row.children ?? []);
  const item: LiveItem = { ...before, status: status as LiveStatus };
  if (item.status === 'ended' && (!item.end || Date.parse(item.end) > now.getTime())) item.end = now.toISOString();
  if (item.status === 'live' && item.start && Date.parse(item.start) > now.getTime()) item.start = now.toISOString();
  await save(q, podcastId, row.id, item, row);

  if (before.status !== 'live' && item.status === 'live') await queuePing(q, config, podcastId, 'live');
  if (before.status === 'live' && item.status !== 'live') await queuePing(q, config, podcastId, 'liveEnd');
  return toLiveItem(row.id, attrsFor(item, row.attributes), applyToChildren(item, row.children ?? []));
}

/** Remove a live item. Removing one that's live counts as the show ending (Podping "liveEnd"). */
export async function deleteLiveItem(q: Queryable, config: Config, podcastId: string, liveId: string): Promise<void> {
  const row = await getRow(q, podcastId, liveId);
  await q.query(`DELETE FROM tag_elements WHERE id = $1`, [row.id]);
  await invalidateFeedCache(q, podcastId);
  if (row.attributes.status === 'live') await queuePing(q, config, podcastId, 'liveEnd');
}
