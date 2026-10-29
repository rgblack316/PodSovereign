/**
 * Readable names for files PodSovereign makes from an episode's audio (Auphonic's results, an MP3 with
 * chapters written in): the upload's own name, "ru053.mp3", then "ru053-2.mp3" and so on. A new version
 * always gets a new address, so CDNs and podcast apps never keep serving a cached old file.
 */
import path from 'node:path';
import { maybeOne, type Queryable } from '../db/db.js';
import { mediaPath } from '../urls.js';

/** "a1b2c3d4-ru053.mp3" → "ru053" (the 8-character prefix uploads get is dropped). */
export function stemOf(filename: string): string {
  return filename.replace(/^[0-9a-f]{8}-/, '').replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
}

const used = async (q: Queryable, slug: string, dir: string, name: string) => {
  const p = mediaPath(slug, dir, name);
  return !!(await maybeOne(q, `SELECT 1 FROM used_media_names WHERE public_path = $1 UNION ALL SELECT 1 FROM media_files WHERE public_path = $1 LIMIT 1`, [p]));
};

/**
 * Reserve the first never-used name for `stem` in the show's folder. A stem that's already a numbered
 * version ("ru053-2", when "ru053.<ext>" was used) continues that series instead of becoming "ru053-2-2".
 */
export async function freeMediaName(q: Queryable, slug: string, dir: string, stem: string, ext: string): Promise<string> {
  let root = stem;
  const m = /^(.*)-(\d+)$/.exec(stem);
  if (m && (await used(q, slug, dir, `${m[1]}.${ext}`))) root = m[1]!;
  for (let i = 1; ; i++) {
    const name = `${root}${i > 1 ? `-${i}` : ''}.${ext}`;
    if (await used(q, slug, dir, name)) continue;
    const r = await q.query(`INSERT INTO used_media_names (public_path) VALUES ($1) ON CONFLICT DO NOTHING RETURNING public_path`, [mediaPath(slug, dir, name)]);
    if (r.rows.length) return name;
  }
}

/** The stem for a stored media file: its original name, else its address. */
export const mediaStem = (m: { original_name: string | null; public_path: string }) => stemOf(m.original_name ?? path.basename(m.public_path));
