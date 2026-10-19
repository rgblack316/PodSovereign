import pg from 'pg';
import type { Db, Queryable } from './db.js';

// bigint (byte sizes) → number; safe up to 9 PB.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPgDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  const wrap = (c: { query: pg.Pool['query'] }): Queryable => ({
    async query(sql, params) {
      const r = await c.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
