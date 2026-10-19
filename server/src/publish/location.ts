/**
 * <podcast:location>: places a show or episode is about (rel="subject", the
 * default) or where it was made (rel="creator"). Several are allowed.
 *
 *   <podcast:location rel="creator" geo="geo:30.2711286,-97.7436995" osm="R113314" country="US">Austin</podcast:location>
 *
 * The place lookup searches OpenStreetMap (Nominatim) to fill in geo, osm and
 * country. Nominatim's usage policy: identify the app, at most one request a
 * second, searches only when someone asks (no autocomplete).
 */
import type { Config } from '../config.js';
import type { XmlNode } from '../feed/types.js';
import { node, oneOf, PublishError, text } from './fields.js';

export interface Place {
  name: string;
  rel: 'subject' | 'creator' | null;
  geo: string | null;
  osm: string | null;
  country: string | null;
}

const MAX_LOCATIONS = 20;
const GEO_RE = /^geo:(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,-?\d+(?:\.\d+)?)?(?:;[\w.=-]+)*$/i;

export function locationsFromTags(tags: XmlNode[]): Place[] {
  return tags
    .filter((t) => t.name === 'podcast:location')
    .map((t) => ({
      name: t.text,
      rel: t.attrs.rel === 'creator' || t.attrs.rel === 'subject' ? t.attrs.rel : null,
      geo: t.attrs.geo ?? null,
      osm: t.attrs.osm ?? null,
      country: t.attrs.country ?? null,
    }));
}

export function locationsToTags(v: unknown): XmlNode[] {
  const list = v === null ? [] : v;
  if (!Array.isArray(list)) throw new PublishError('Locations must be a list');
  if (list.length > MAX_LOCATIONS) throw new PublishError(`At most ${MAX_LOCATIONS} locations`);
  return list.map((l, i) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const label = `Location ${i + 1}`;
    const name = text(o.name, `${label} name`, { required: true, max: 128 })!;
    const attrs: Record<string, string> = {};
    const rel = oneOf(o.rel, `${label} type`, ['subject', 'creator'] as const);
    if (rel) attrs.rel = rel;
    const geo = text(o.geo, `${label} coordinates`, { max: 200 });
    if (geo) {
      const m = GEO_RE.exec(geo);
      if (!m || Math.abs(Number(m[1])) > 90 || Math.abs(Number(m[2])) > 180) {
        throw new PublishError(`${label} coordinates must look like geo:33.6,-84.2 (latitude, longitude)`);
      }
      attrs.geo = geo.replace(/^GEO:/, 'geo:');
    }
    const osm = text(o.osm, `${label} OpenStreetMap ID`, { max: 40 });
    if (osm) {
      if (!/^[NWR]\d+$/i.test(osm)) throw new PublishError(`${label} OpenStreetMap ID must be N, W or R followed by digits, e.g. R113314`);
      attrs.osm = osm.toUpperCase();
    }
    const country = text(o.country, `${label} country`, { max: 2 });
    if (country) {
      if (!/^[A-Za-z]{2}$/.test(country)) throw new PublishError(`${label} country must be a two-letter code, e.g. US`);
      attrs.country = country.toUpperCase();
    }
    return node('podcast:location', attrs, name);
  });
}

// ───────────── place lookup (OpenStreetMap Nominatim) ─────────────

export interface PlaceResult {
  name: string;
  label: string;
  geo: string;
  osm: string | null;
  country: string | null;
}

let lastLookup = 0;

export async function lookupPlace(config: Config, query: unknown, fetchImpl: typeof fetch = fetch): Promise<PlaceResult[]> {
  const q = typeof query === 'string' ? query.trim().slice(0, 200) : '';
  if (q.length < 2) throw new PublishError('Type a place to look up');
  // One request a second across the whole server.
  const wait = lastLookup + 1000 - Date.now();
  lastLookup = Math.max(Date.now(), lastLookup + 1000);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  const url = new URL('search', config.nominatimUrl.replace(/\/?$/, '/'));
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '6');
  let rows: unknown;
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': `FeedHost/0.1 (+${config.publicBaseUrl})`, Accept: 'application/json', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rows = await res.json();
  } catch (e) {
    throw new PublishError(`Couldn’t reach OpenStreetMap to look that up (${(e as Error).message}). You can still type the details in.`, 502);
  }
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: Record<string, any>) => {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const type: string = typeof r.osm_type === 'string' ? (r.osm_type[0] ?? '').toUpperCase() : '';
    const label = String(r.display_name ?? '');
    return [{
      name: String(r.name || label.split(',')[0] || q).slice(0, 128),
      label,
      geo: `geo:${lat.toFixed(7).replace(/\.?0+$/, '')},${lon.toFixed(7).replace(/\.?0+$/, '')}`,
      osm: ['N', 'W', 'R'].includes(type) && r.osm_id ? `${type}${r.osm_id}` : null,
      country: typeof r.address?.country_code === 'string' ? r.address.country_code.toUpperCase() : null,
    }];
  });
}
