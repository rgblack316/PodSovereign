/**
 * One-time catch-up: add Podlove Simple Chapters (<psc:chapters>) to episodes whose chapters were saved before
 * that block existed. Each episode's saved chapters file is read and its Podlove copy added to the feed entry.
 * Nothing else about the episode changes (not its date, text or chapters file), and running it again does nothing
 * for episodes that already have the block. It runs in the background, one episode at a time.
 */
import type { Config } from '../config.js';
import { maybeOne, type Db } from '../db/db.js';
import { storeFor } from '../storage/store.js';
import { parseChaptersJson, pscChapters } from './chapters.js';

export interface CatchupState {
  running: boolean;
  total: number;
  done: number;
  added: number;
  /** No chapters file stored on this site, or nothing to show (every chapter hidden). */
  skipped: number;
  failed: number;
  /** The last few problems, for the person to read. */
  problems: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

const fresh = (): CatchupState => ({ running: false, total: 0, done: 0, added: 0, skipped: 0, failed: 0, problems: [], startedAt: null, finishedAt: null });
let state: CatchupState = fresh();

export const catchupState = (): CatchupState => ({ ...state, problems: [...state.problems] });

interface Pending { episode_id: string; podcast_id: string; title: string; url: string | null }

const PENDING_SQL = `
  SELECT e.id AS episode_id, e.podcast_id, e.title, t.attributes->>'url' AS url
    FROM tag_elements t JOIN episodes e ON e.id = t.episode_id
   WHERE t.ns_prefix = 'podcast' AND t.name = 'chapters'
     AND NOT EXISTS (SELECT 1 FROM tag_elements p WHERE p.episode_id = e.id AND p.ns_prefix = 'psc' AND p.name = 'chapters')
   ORDER BY e.podcast_id, e.pub_date NULLS LAST`;

/** How many episodes have a chapters file but no Podlove block yet. */
export async function pendingCount(db: Db): Promise<number> {
  return (await db.query(PENDING_SQL)).rows.length;
}

async function one(db: Db, config: Config, p: Pending): Promise<'added' | 'skipped'> {
  if (!p.url || !p.url.startsWith(config.mediaBaseUrl + '/')) return 'skipped';
  const m = await maybeOne<{ storage_key: string | null; storage_provider: string | null; public_path: string }>(
    db, `SELECT storage_key, storage_provider, public_path FROM media_files WHERE podcast_id = $1 AND public_path = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`,
    [p.podcast_id, p.url.slice(config.mediaBaseUrl.length)]);
  if (!m) return 'skipped';
  const text = (await storeFor(config, m.storage_provider).getBuffer(m.storage_key ?? m.public_path.slice(1))).toString('utf8');
  const node = pscChapters(parseChaptersJson(text));
  if (!node) return 'skipped';
  const done = await db.tx(async (q) => {
    // Added only if it still isn't there (the chapters may have been saved meanwhile), after the episode's other tags.
    const r = await q.query(
      `INSERT INTO tag_elements (podcast_id, episode_id, ns_uri, ns_prefix, name, attributes, value, cdata, children, sort_order)
       SELECT $1, $2, 'http://podlove.org/simple-chapters', 'psc', 'chapters', $3::json, NULL, false, $4::json,
              COALESCE((SELECT max(sort_order) FROM tag_elements WHERE episode_id = $2), 0) + 1
        WHERE NOT EXISTS (SELECT 1 FROM tag_elements WHERE episode_id = $2 AND ns_prefix = 'psc' AND name = 'chapters')`,
      [p.podcast_id, p.episode_id, JSON.stringify(node.attrs), JSON.stringify(node.children)]);
    return (r.rowCount ?? 0) > 0;
  });
  return done ? 'added' : 'skipped';
}

/** Start the catch-up in the background. Returns false when one is already running. */
export function startCatchup(db: Db, config: Config, log?: (m: string) => void): boolean {
  if (state.running) return false;
  state = { ...fresh(), running: true, startedAt: new Date().toISOString() };
  void (async () => {
    const touched = new Set<string>();
    try {
      const pending = (await db.query<Pending>(PENDING_SQL)).rows;
      state.total = pending.length;
      for (const p of pending) {
        try {
          const r = await one(db, config, p);
          if (r === 'added') {
            state.added++;
            touched.add(p.podcast_id);
          } else state.skipped++;
        } catch (e) {
          state.failed++;
          if (state.problems.length < 10) state.problems.push(`${p.title}: ${(e as Error).message}`);
          log?.(`psc catch-up: ${p.episode_id}: ${(e as Error).message}`);
        }
        state.done++;
      }
    } catch (e) {
      state.problems.push((e as Error).message);
      log?.(`psc catch-up: ${(e as Error).message}`);
    } finally {
      // The feeds are rebuilt on their next request.
      if (touched.size) {
        await db.query(`UPDATE podcasts SET feed_cache_xml = NULL, feed_cache_etag = NULL WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`, [JSON.stringify([...touched])])
          .catch((e) => log?.(`psc catch-up: couldn’t refresh the feeds: ${(e as Error).message}`));
      }
      state.running = false;
      state.finishedAt = new Date().toISOString();
      log?.(`psc catch-up: ${state.added} added, ${state.skipped} skipped, ${state.failed} failed`);
    }
  })();
  return true;
}
