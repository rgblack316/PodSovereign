import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Apply pending migrations in filename order, each in its own transaction. */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(DIR + f, 'utf8');
    await db.tx(async (q) => {
      await q.query(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    log(`applied ${f}`);
    applied.push(f);
  }
  return applied;
}
