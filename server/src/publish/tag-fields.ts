/**
 * Podcasting 2.0 tags that have their own form in the dashboard, at show
 * (channel) and/or episode (item) level. Each field reads its tags from the
 * stored tag list and turns the form's input back into tags. Tags without a
 * form stay in the "Other tags" XML box.
 *
 * Nothing is converted on upgrade: a form simply reads the tags that were
 * already stored (from an import or the XML box), and they stop appearing in
 * the box. The feed stays byte-for-byte the same until someone edits a field.
 */
import type { Config } from '../config.js';
import type { Queryable } from '../db/db.js';
import type { XmlNode } from '../feed/types.js';
import { httpUrl, node, parseTagsXml, PublishError, tagsToXml, text } from './fields.js';
import { locationsFromTags, locationsToTags } from './location.js';
import { peopleFromTags, peopleToTags } from './people.js';

export interface FieldCtx {
  q: Queryable;
  config: Config;
  podcastId: string;
  namespaces: Record<string, string>;
}

export interface TagField {
  /** Key in the API's view and input. */
  key: string;
  /** Tag names this field owns. */
  tags: string[];
  /** Shown when someone types one of these tags into Other tags. */
  label: string;
  levels: ('channel' | 'item')[];
  from(nodes: XmlNode[]): unknown;
  to(ctx: FieldCtx, input: unknown): Promise<XmlNode[]>;
}

const list = (v: unknown, field: string, max: number): unknown[] => {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new PublishError(`${field} must be a list`);
  if (v.length > max) throw new PublishError(`${field}: at most ${max}`);
  return v;
};
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const slug = (v: unknown, field: string, fallback?: string): string => {
  const s = text(v, field, { max: 50 }) ?? fallback;
  if (!s) throw new PublishError(`${field} is required`);
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new PublishError(`${field} may only use letters, numbers, dots and dashes`);
  return s;
};

// ───────────── podcast:value ─────────────

export interface ValueRecipient {
  name: string | null;
  type: string;
  address: string;
  split: number;
  fee: boolean;
  customKey: string | null;
  customValue: string | null;
}
export interface ValueBlock {
  type: string;
  method: string;
  suggested: string | null;
  recipients: ValueRecipient[];
  /** Other tags inside the block (e.g. podcast:valueTimeSplit), as XML, kept as they are. */
  other: string;
}

function valueFrom(nodes: XmlNode[]): ValueBlock[] {
  return nodes.map((n) => ({
    type: n.attrs.type ?? 'lightning',
    method: n.attrs.method ?? 'keysend',
    suggested: n.attrs.suggested ?? null,
    recipients: n.children.filter((c) => c.name === 'podcast:valueRecipient').map((c) => ({
      name: c.attrs.name ?? null,
      type: c.attrs.type ?? 'node',
      address: c.attrs.address ?? '',
      split: Number(c.attrs.split ?? 0),
      fee: c.attrs.fee === 'true',
      customKey: c.attrs.customKey ?? null,
      customValue: c.attrs.customValue ?? null,
    })),
    other: tagsToXml(n.children.filter((c) => c.name !== 'podcast:valueRecipient')),
  }));
}

async function valueTo(ctx: FieldCtx, input: unknown): Promise<XmlNode[]> {
  const blocks = list(input, 'Value', 5);
  return blocks.map((b, i) => {
    const o = obj(b);
    const label = blocks.length > 1 ? `Value block ${i + 1}` : 'Value';
    const attrs: Record<string, string> = {
      type: slug(o.type, `${label} type`, 'lightning'),
      method: slug(o.method, `${label} method`, 'keysend'),
    };
    const suggested = text(o.suggested, `${label} suggested amount`, { max: 30 });
    if (suggested) {
      if (!/^\d+(\.\d+)?$/.test(suggested)) throw new PublishError('Suggested amount must be a number, e.g. 0.00005000000');
      attrs.suggested = suggested;
    }
    const recipients = list(o.recipients, 'Recipients', 100);
    if (!recipients.length) throw new PublishError('Add at least one recipient to receive payments');
    const children = recipients.map((r, j) => {
      const p = obj(r);
      const who = `Recipient ${j + 1}`;
      const a: Record<string, string> = {};
      const name = text(p.name, `${who} name`, { max: 128 });
      if (name) a.name = name;
      a.type = slug(p.type, `${who} type`, 'node');
      const address = text(p.address, `${who} address`, { required: true, max: 500 })!;
      if (a.type === 'node' && !/^[0-9a-f]{66}$/i.test(address)) throw new PublishError(`${who}: a node address is the 66-character node public key`);
      if (a.type === 'lnaddress' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new PublishError(`${who}: a Lightning address looks like name@example.com`);
      a.address = address;
      const split = typeof p.split === 'string' ? Number(p.split) : p.split;
      if (typeof split !== 'number' || !Number.isInteger(split) || split < 0 || split > 1_000_000) {
        throw new PublishError(`${who}: split must be a whole number of shares`);
      }
      a.split = String(split);
      if (p.fee === true) a.fee = 'true';
      const key = text(p.customKey, `${who} custom key`, { max: 200 });
      const value = text(p.customValue, `${who} custom value`, { max: 500 });
      if (key) a.customKey = key;
      if (value) a.customValue = value;
      return node('podcast:valueRecipient', a);
    });
    if (!children.some((c) => Number(c.attrs.split) > 0)) throw new PublishError('At least one recipient needs a split above 0');
    const other = parseTagsXml(o.other ?? '', ctx.namespaces, new Map([['podcast:valueRecipient', 'Recipients']])).nodes;
    return { name: 'podcast:value', attrs, text: '', cdata: false, children: [...children, ...other] };
  });
}

// ───────────── podcast:funding ─────────────

function fundingFrom(nodes: XmlNode[]) {
  return nodes.map((n) => ({ url: n.attrs.url ?? '', label: n.text }));
}
async function fundingTo(_ctx: FieldCtx, input: unknown): Promise<XmlNode[]> {
  return list(input, 'Funding', 10).map((f, i) => {
    const o = obj(f);
    const url = httpUrl(o.url, `Funding link ${i + 1}`);
    if (!url) throw new PublishError(`Funding link ${i + 1} needs a web address`);
    const label = text(o.label, `Funding link ${i + 1} text`, { required: true, max: 128 })!;
    return node('podcast:funding', { url }, label);
  });
}

// ───────────── podcast:podroll ─────────────

function podrollFrom(nodes: XmlNode[]) {
  return (nodes[0]?.children ?? [])
    .filter((c) => c.name === 'podcast:remoteItem')
    .map((c) => ({ feedGuid: c.attrs.feedGuid ?? '', feedUrl: c.attrs.feedUrl ?? null, medium: c.attrs.medium ?? null }));
}
async function podrollTo(_ctx: FieldCtx, input: unknown): Promise<XmlNode[]> {
  const items = list(input, 'Recommended shows', 100);
  if (!items.length) return [];
  const children = items.map((r, i) => {
    const o = obj(r);
    const guid = text(o.feedGuid, `Recommended show ${i + 1} GUID`, { required: true, max: 200 })!;
    const attrs: Record<string, string> = { feedGuid: guid };
    const url = httpUrl(o.feedUrl, `Recommended show ${i + 1} feed address`);
    if (url) attrs.feedUrl = url;
    const medium = text(o.medium, `Recommended show ${i + 1} medium`, { max: 30 });
    if (medium) attrs.medium = medium;
    return node('podcast:remoteItem', attrs);
  });
  return [{ name: 'podcast:podroll', attrs: {}, text: '', cdata: false, children }];
}

// ───────────── podcast:updateFrequency ─────────────

const RRULE_RE = /^FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Za-z0-9,:+.-]+)*$/;

function frequencyFrom(nodes: XmlNode[]) {
  const n = nodes[0];
  return n ? { label: n.text, rrule: n.attrs.rrule ?? null, dtstart: n.attrs.dtstart ?? null, complete: n.attrs.complete === 'true' } : null;
}
async function frequencyTo(_ctx: FieldCtx, input: unknown): Promise<XmlNode[]> {
  if (input === null || input === undefined) return [];
  const o = obj(input);
  const attrs: Record<string, string> = {};
  if (o.complete === true) attrs.complete = 'true';
  const dtstart = text(o.dtstart, 'Schedule start', { max: 40 });
  if (dtstart) {
    if (Number.isNaN(Date.parse(dtstart))) throw new PublishError('Schedule start must be a date, e.g. 2026-11-02');
    attrs.dtstart = dtstart;
  }
  const rrule = text(o.rrule, 'Schedule rule', { max: 300 })?.toUpperCase().replace(/^RRULE:/, '') ?? null;
  if (rrule) {
    if (!RRULE_RE.test(rrule)) throw new PublishError('Schedule rule must be an iCalendar rule like FREQ=WEEKLY or FREQ=WEEKLY;INTERVAL=2');
    if (/(^|;)COUNT=/.test(rrule) && !dtstart) throw new PublishError('A schedule with a set number of episodes (COUNT) needs a start date');
    attrs.rrule = rrule;
  }
  const label = text(o.label, 'Schedule description', { max: 128 });
  if (!label && !rrule && !attrs.complete) return [];
  return [node('podcast:updateFrequency', attrs, label ?? (attrs.complete ? 'Complete' : 'Scheduled'))];
}

// ───────────── podcast:license ─────────────

function licenseFrom(nodes: XmlNode[]) {
  const n = nodes[0];
  return n ? { identifier: n.text, url: n.attrs.url ?? null } : null;
}
async function licenseTo(_ctx: FieldCtx, input: unknown): Promise<XmlNode[]> {
  if (input === null || input === undefined) return [];
  const o = obj(input);
  const identifier = text(o.identifier, 'License', { max: 128 });
  if (!identifier) return [];
  const url = httpUrl(o.url, 'License address');
  return [node('podcast:license', url ? { url } : {}, identifier)];
}

// ───────────── podcast:txt ─────────────

function txtFrom(nodes: XmlNode[]) {
  return nodes.map((n) => ({ purpose: n.attrs.purpose ?? null, value: n.text }));
}
async function txtTo(_ctx: FieldCtx, input: unknown): Promise<XmlNode[]> {
  return list(input, 'Text records', 20).map((t, i) => {
    const o = obj(t);
    const value = text(o.value, `Text record ${i + 1}`, { required: true, max: 4000 })!;
    const purpose = text(o.purpose, `Text record ${i + 1} purpose`, { max: 128 });
    return node('podcast:txt', purpose ? { purpose } : {}, value);
  });
}

// ───────────── the list ─────────────

export const TAG_FIELDS: TagField[] = [
  { key: 'people', tags: ['podcast:person'], label: 'People', levels: ['channel', 'item'], from: peopleFromTags, to: (c, v) => peopleToTags(c.q, c.config, c.podcastId, v) },
  { key: 'locations', tags: ['podcast:location'], label: 'Locations', levels: ['channel', 'item'], from: locationsFromTags, to: async (_c, v) => locationsToTags(v) },
  { key: 'value', tags: ['podcast:value'], label: 'Value', levels: ['channel', 'item'], from: valueFrom, to: valueTo },
  { key: 'funding', tags: ['podcast:funding'], label: 'Funding', levels: ['channel', 'item'], from: fundingFrom, to: fundingTo },
  { key: 'podroll', tags: ['podcast:podroll'], label: 'Recommended shows', levels: ['channel'], from: podrollFrom, to: podrollTo },
  { key: 'updateFrequency', tags: ['podcast:updateFrequency'], label: 'Publishing schedule', levels: ['channel'], from: frequencyFrom, to: frequencyTo },
  { key: 'license', tags: ['podcast:license'], label: 'License', levels: ['channel', 'item'], from: licenseFrom, to: licenseTo },
  { key: 'txt', tags: ['podcast:txt'], label: 'Text records', levels: ['channel', 'item'], from: txtFrom, to: txtTo },
];

export const fieldsFor = (level: 'channel' | 'item') => TAG_FIELDS.filter((f) => f.levels.includes(level));

/** Tag name → field label, for refusing those tags in the Other tags box. */
export function fieldTagLabels(level: 'channel' | 'item'): [string, string][] {
  return fieldsFor(level).flatMap((f) => f.tags.map((t) => [t, f.label] as [string, string]));
}

/** Each field's current value, read from the stored tags. */
export function fieldViews(level: 'channel' | 'item', tags: XmlNode[]): Record<string, unknown> {
  return Object.fromEntries(fieldsFor(level).map((f) => [f.key, f.from(tags.filter((t) => f.tags.includes(t.name)))]));
}

/**
 * Rebuild the field-owned tags: fields present in the input are replaced,
 * the rest keep their stored tags. Returns null when no field was in the input.
 */
export async function applyFields(
  level: 'channel' | 'item',
  ctx: FieldCtx,
  stored: XmlNode[],
  input: Record<string, unknown>,
): Promise<XmlNode[] | null> {
  const fields = fieldsFor(level);
  if (!fields.some((f) => input[f.key] !== undefined)) return null;
  const out: XmlNode[] = [];
  for (const f of fields) {
    out.push(...(input[f.key] !== undefined ? await f.to(ctx, input[f.key]) : stored.filter((t) => f.tags.includes(t.name))));
  }
  return out;
}

export const isFieldTag = (level: 'channel' | 'item', name: string) => fieldsFor(level).some((f) => f.tags.includes(name));

// ───────────── podroll lookup ─────────────

/**
 * Read another show's feed to fill in a recommended-show entry: its title and
 * podcast:guid. Feeds without a podcast:guid get the one the Podcast Namespace
 * defines for them (a UUIDv5 of the feed address).
 */
export async function lookupFeed(config: Config, url: unknown) {
  const { fetchFeedText } = await import('../import/http.js');
  const { parseFeed } = await import('../feed/parser.js');
  const { podcastGuidFor } = await import('../import/importer.js');
  const feedUrl = httpUrl(url, 'Feed address');
  if (!feedUrl) throw new PublishError('Paste the show’s feed address');
  let feed;
  try {
    const { text: xml } = await fetchFeedText(feedUrl, { allowPrivate: config.allowPrivateNetworks, maxBytes: config.maxFeedBytes, timeoutMs: 15_000 });
    feed = parseFeed(xml).feed;
  } catch (e) {
    throw new PublishError(`Couldn’t read that feed: ${(e as Error).message}`, 502);
  }
  const guid = feed.channel.podcastGuid?.trim();
  return {
    title: feed.channel.title || null,
    imageUrl: feed.channel.imageUrl,
    feedUrl,
    feedGuid: guid || podcastGuidFor(feedUrl),
    guidFromFeed: !!guid,
    medium: feed.channel.podcastMedium,
  };
}
