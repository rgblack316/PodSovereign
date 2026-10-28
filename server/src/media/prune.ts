/**
 * Deleting media nobody uses any more: an episode's old audio after it's
 * replaced, its files after the episode is deleted, and uploads that were
 * never saved into an episode.
 *
 * A file counts as "in use" when its path appears anywhere in the show's
 * stored content (episodes, show details, tags). Paths are matched without
 * the host, so a change of web or media address doesn't matter.
 */
import type { Config } from '../config.js';
import type { Queryable } from '../db/db.js';
import { storeFor } from '../storage/store.js';
import { mediaPrefix } from '../urls.js';

export async function isReferenced(q: Queryable, podcastId: string, publicPath: string): Promise<boolean> {
  const { rows } = await q.query<{ used: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM episodes WHERE podcast_id = $1 AND (
                position($2 in coalesce(enclosure_url, '')) > 0 OR position($2 in coalesce(itunes_image_url, '')) > 0
             OR position($2 in coalesce(description, '')) > 0))
         OR EXISTS (SELECT 1 FROM podcasts WHERE id = $1 AND (
                position($2 in coalesce(image_url, '')) > 0 OR position($2 in coalesce(description, '')) > 0))
         OR EXISTS (SELECT 1 FROM tag_elements WHERE podcast_id = $1 AND (
                position($2 in attributes::text) > 0 OR position($2 in coalesce(children::text, '')) > 0
             OR position($2 in coalesce(value, '')) > 0))
         -- The original upload of an episode's latest Auphonic processing, kept for reprocessing.
         OR EXISTS (SELECT 1 FROM (SELECT DISTINCT ON (episode_id) original_media_id FROM auphonic_jobs
                                    WHERE podcast_id = $1 ORDER BY episode_id, created_at DESC) j
                      JOIN media_files m ON m.id = j.original_media_id WHERE m.public_path = $2) AS used`,
    [podcastId, publicPath],
  );
  return rows[0]?.used ?? true;
}

/** The media paths (/<slug>/media/…) of this show found in a list of URLs. */
export function ownMediaPaths(slug: string, urls: Iterable<string | null | undefined>): string[] {
  const prefix = mediaPrefix(slug);
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    const i = u.indexOf(prefix);
    if (i >= 0) out.add(u.slice(i).split(/[?#\s"']/)[0]!);
  }
  return [...out];
}

/** Delete each file that's no longer used anywhere in the show. Returns how many were deleted. */
export async function pruneMedia(
  q: Queryable,
  config: Config,
  podcastId: string,
  publicPaths: string[],
  log?: (m: string) => void,
): Promise<number> {
  let n = 0;
  for (const p of new Set(publicPaths)) {
    const row = (await q.query<{ id: string; storage_key: string | null; storage_provider: string }>(
      `SELECT id, storage_key, storage_provider FROM media_files WHERE podcast_id = $1 AND public_path = $2`,
      [podcastId, p],
    )).rows[0];
    if (!row || (await isReferenced(q, podcastId, p))) continue;
    try {
      await q.query(`UPDATE episodes SET enclosure_media_id = NULL WHERE enclosure_media_id = $1`, [row.id]);
      await q.query(`DELETE FROM media_files WHERE id = $1`, [row.id]);
    } catch (e) {
      log?.(`couldn't remove media row ${p}: ${(e as Error).message}`);
      continue;
    }
    if (row.storage_key) {
      try {
        await storeFor(config, row.storage_provider).delete(row.storage_key);
      } catch (e) {
        log?.(`couldn't delete ${row.storage_key}: ${(e as Error).message}`);
      }
    }
    n++;
  }
  return n;
}
