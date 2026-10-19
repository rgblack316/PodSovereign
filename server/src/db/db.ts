/** Minimal database interface so the app can run on `pg` and tests on a local client. */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  /** Run `fn` inside a transaction on a dedicated connection. Rolls back on throw. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Throws if the query didn't return exactly one row. */
export async function one<T>(q: Queryable, sql: string, params?: unknown[]): Promise<T> {
  const { rows } = await q.query<T>(sql, params);
  if (rows.length !== 1) throw new Error(`Expected 1 row, got ${rows.length}`);
  return rows[0]!;
}

export async function maybeOne<T>(q: Queryable, sql: string, params?: unknown[]): Promise<T | null> {
  const { rows } = await q.query<T>(sql, params);
  return rows[0] ?? null;
}
