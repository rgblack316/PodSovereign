/** Validation and tag helpers shared by show and episode editing. */
import type { Config } from '../config.js';
import type { Queryable } from '../db/db.js';
import { CANONICAL_NS } from '../feed/namespaces.js';
import type { XmlNode } from '../feed/types.js';
import { escAttr, parseXml, serializeNode } from '../feed/xml.js';
import { getMedia, type MediaJson } from '../media/uploads.js';

export class PublishError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function text(v: unknown, field: string, opts: { max?: number; required?: boolean } = {}): string | null {
  if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) {
    if (opts.required) throw new PublishError(`${field} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new PublishError(`${field} must be text`);
  const s = v.trim();
  if (opts.max && s.length > opts.max) throw new PublishError(`${field} is too long (at most ${opts.max} characters)`);
  return s;
}

export function httpUrl(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new PublishError(`${field} must be a web address`);
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
    return u.toString();
  } catch {
    throw new PublishError(`${field} must be a full web address starting with https://`);
  }
}

export function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new PublishError(`${field} must be true or false`);
  return v;
}

export function optionalBool(v: unknown, field: string): boolean | null {
  if (v === null) return null;
  return bool(v, field);
}

export function wholeNumber(v: unknown, field: string, max = 1_000_000): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) throw new PublishError(`${field} must be a whole number`);
  return n;
}

export function email(v: unknown, field: string): string | null {
  const s = text(v, field, { max: 320 });
  if (s && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) throw new PublishError(`${field} must be an email address`);
  return s;
}

export function oneOf<T extends string>(v: unknown, field: string, values: readonly T[]): T | null {
  if (v === null || v === undefined || v === '') return null;
  if (!values.includes(v as T)) throw new PublishError(`${field} must be one of: ${values.join(', ')}`);
  return v as T;
}

/**
 * A file reference from the editor: {mediaId} for a file uploaded to this
 * show, or {url} for one hosted elsewhere. Returns null for null.
 */
export async function fileRef(
  q: Queryable,
  config: Config,
  podcastId: string,
  v: unknown,
  field: string,
  kinds: string[],
): Promise<{ url: string; media: MediaJson | null } | null> {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { url: httpUrl(v, field)!, media: null };
  if (typeof v !== 'object') throw new PublishError(`${field} must be an uploaded file or a web address`);
  const o = v as { mediaId?: unknown; url?: unknown };
  if (o.mediaId !== undefined && o.mediaId !== null) {
    const m = await getMedia(q, config, podcastId, o.mediaId);
    if (!m) throw new PublishError(`${field}: that uploaded file wasn’t found. Upload it again.`);
    if (!kinds.includes(m.kind)) throw new PublishError(`${field} can’t use a ${m.kind} file`);
    return { url: m.url, media: m };
  }
  const url = httpUrl(o.url, field);
  return url ? { url, media: null } : null;
}

export const node = (name: string, attrs: Record<string, string> = {}, value = '', cdata = false): XmlNode => ({
  name,
  attrs,
  text: value,
  cdata,
  children: [],
});

// ───────────── "Other tags" (raw XML) ─────────────

const MAX_TAGS_XML = 200_000;

/** Tags as editable XML, one top-level element after another. */
export function tagsToXml(nodes: XmlNode[]): string {
  return nodes.map((n) => serializeNode(n, '')).join('\n');
}

/**
 * Parse the "Other tags" box. Every namespace the feed knows is predeclared;
 * a new one can be declared on the element itself (xmlns:foo="…") and is
 * added to the feed. Tags that have their own field are refused, so there's
 * one place to edit each thing.
 */
export function parseTagsXml(
  xml: unknown,
  namespaces: Record<string, string>,
  managed: Map<string, string>,
): { nodes: XmlNode[]; namespaces: Record<string, string> } {
  if (xml === null || xml === undefined) return { nodes: [], namespaces: {} };
  if (typeof xml !== 'string') throw new PublishError('Other tags must be XML text');
  if (xml.length > MAX_TAGS_XML) throw new PublishError('Other tags is too long');
  if (!xml.trim()) return { nodes: [], namespaces: {} };
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(xml)) throw new PublishError('Other tags may only contain elements');

  const decl = Object.entries({ ...namespaces, ...CANONICAL_NS })
    .map(([p, uri]) => ` xmlns:${p}="${escAttr(uri)}"`)
    .join('');
  const parsed = parseXml(`<fh-tags${decl}>\n${xml}\n</fh-tags>`);
  if (parsed.warnings.length) {
    throw new PublishError(`Other tags isn’t valid XML: ${parsed.warnings[0]!.replace(/\s+/g, ' ')}`);
  }
  if (parsed.root.name !== 'fh-tags' || parsed.root.text.trim()) {
    throw new PublishError('Other tags must contain only XML elements, with no loose text between them');
  }
  for (const n of parsed.root.children) {
    const why = managed.get(n.name);
    if (why) throw new PublishError(`<${n.name}> has its own field (${why}). Remove it from Other tags.`);
  }
  return { nodes: parsed.root.children, namespaces: parsed.namespaces };
}

/** Insert tags for a show (episodeId null) or an episode, in order. */
export async function insertTags(
  q: Queryable,
  podcastId: string,
  episodeId: string | null,
  nodes: XmlNode[],
  namespaces: Record<string, string>,
): Promise<void> {
  if (!nodes.length) return;
  const rows = nodes.map((n, i) => {
    const c = n.name.indexOf(':');
    const prefix = c > 0 ? n.name.slice(0, c) : '';
    return {
      ns_uri: prefix ? (CANONICAL_NS[prefix] ?? namespaces[prefix] ?? '') : '',
      ns_prefix: prefix,
      name: c > 0 ? n.name.slice(c + 1) : n.name,
      attributes: n.attrs,
      value: n.text || null,
      cdata: n.cdata,
      children: n.children.length ? n.children : null,
      sort_order: i,
    };
  });
  await q.query(
    `INSERT INTO tag_elements (podcast_id, episode_id, ns_uri, ns_prefix, name, attributes, value, cdata, children, sort_order)
     SELECT $1, $2, x.ns_uri, x.ns_prefix, x.name, x.attributes, x.value, x.cdata, x.children, x.sort_order
       FROM json_to_recordset($3::json) AS x(ns_uri text, ns_prefix text, name text, attributes json, value text,
            cdata boolean, children json, sort_order int)`,
    [podcastId, episodeId, JSON.stringify(rows)],
  );
}

/** Add namespaces declared in "Other tags" to the show. */
export async function addNamespaces(q: Queryable, podcastId: string, ns: Record<string, string>): Promise<void> {
  const extra = Object.fromEntries(Object.entries(ns).filter(([p]) => !CANONICAL_NS[p]));
  if (!Object.keys(extra).length) return;
  await q.query(`UPDATE podcasts SET extra_namespaces = extra_namespaces || $2::jsonb WHERE id = $1`, [podcastId, JSON.stringify(extra)]);
}
