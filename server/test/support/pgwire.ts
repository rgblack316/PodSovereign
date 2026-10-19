/**
 * TEST-ONLY minimal PostgreSQL client (extended query protocol, trust auth,
 * Unix socket). Exists because the `pg` package can't be installed in the
 * build sandbox; production uses src/db/pg.ts. Not for production use.
 */
import net from 'node:net';
import type { Db, Queryable, QueryResult } from '../../src/db/db.js';

interface Field { name: string; type: number }

class Conn {
  private sock: net.Socket;
  private buf = Buffer.alloc(0);
  private waiters: ((m: { type: string; body: Buffer }) => void)[] = [];
  private queue: { type: string; body: Buffer }[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.sock = net.createConnection({ path });
    this.sock.on('data', (d: Buffer) => this.onData(d));
  }

  static async open(socketPath: string, user: string, database: string): Promise<Conn> {
    const c = new Conn(socketPath);
    await new Promise<void>((res, rej) => c.sock.once('connect', res).once('error', rej));
    const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`);
    const head = Buffer.alloc(8);
    head.writeInt32BE(8 + params.length, 0);
    head.writeInt32BE(196608, 4);
    c.sock.write(Buffer.concat([head, params]));
    for (;;) {
      const m = await c.next();
      if (m.type === 'E') throw new Error(parseError(m.body));
      if (m.type === 'R' && m.body.readInt32BE(0) !== 0) throw new Error('Only trust auth is supported in tests');
      if (m.type === 'Z') return c;
    }
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const msg = { type: String.fromCharCode(this.buf[0]!), body: this.buf.subarray(5, len + 1) };
      this.buf = this.buf.subarray(len + 1);
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    }
  }

  private next(): Promise<{ type: string; body: Buffer }> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((res) => this.waiters.push(res));
  }

  private send(type: string, body: Buffer) {
    const h = Buffer.alloc(5);
    h.write(type, 0);
    h.writeInt32BE(body.length + 4, 1);
    this.sock.write(Buffer.concat([h, body]));
  }

  query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const run = this.chain.then(() => this.run<T>(sql, params));
    this.chain = run.catch(() => {});
    return run;
  }

  private async run<T>(sql: string, params: unknown[]): Promise<QueryResult<T>> {
    const cstr = (s: string) => Buffer.from(s + '\0');
    const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
    const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

    if (params.length === 0) {
      // Simple protocol, like `pg` does without params — allows multi-statement SQL (migrations).
      this.send('Q', cstr(sql));
      return this.collect<T>();
    }
    this.send('P', Buffer.concat([cstr(''), cstr(sql), i16(0)]));
    const vals = params.map((p) => {
      if (p === null || p === undefined) return i32(-1);
      const s = p instanceof Date ? p.toISOString() : typeof p === 'object' ? JSON.stringify(p) : String(p);
      const b = Buffer.from(s);
      return Buffer.concat([i32(b.length), b]);
    });
    this.send('B', Buffer.concat([cstr(''), cstr(''), i16(0), i16(params.length), ...vals, i16(0)]));
    this.send('D', Buffer.concat([Buffer.from('P'), cstr('')]));
    this.send('E', Buffer.concat([cstr(''), i32(0)]));
    this.send('S', Buffer.alloc(0));
    return this.collect<T>();
  }

  private async collect<T>(): Promise<QueryResult<T>> {
    let fields: Field[] = [];
    const rows: T[] = [];
    let rowCount = 0;
    let error: string | null = null;
    for (;;) {
      const m = await this.next();
      switch (m.type) {
        case 'T': fields = parseRowDesc(m.body); break;
        case 'D': rows.push(parseRow(m.body, fields) as T); break;
        case 'C': {
          const tag = m.body.toString('utf8', 0, m.body.length - 1);
          const n = Number(tag.split(' ').pop());
          rowCount = Number.isNaN(n) ? 0 : n;
          break;
        }
        case 'E': error = parseError(m.body); break;
        case 'Z':
          if (error) throw new Error(error);
          return { rows, rowCount };
      }
    }
  }

  end() {
    this.send('X', Buffer.alloc(0));
    this.sock.end();
  }
}

function parseError(b: Buffer): string {
  const f: Record<string, string> = {};
  let i = 0;
  while (i < b.length && b[i] !== 0) {
    const code = String.fromCharCode(b[i]!);
    const end = b.indexOf(0, i + 1);
    f[code] = b.toString('utf8', i + 1, end);
    i = end + 1;
  }
  const err = `${f.M ?? 'error'}${f.D ? ` (${f.D})` : ''}`;
  return f.C ? `[${f.C}] ${err}` : err;
}

function parseRowDesc(b: Buffer): Field[] {
  const n = b.readInt16BE(0);
  const out: Field[] = [];
  let i = 2;
  for (let k = 0; k < n; k++) {
    const end = b.indexOf(0, i);
    const name = b.toString('utf8', i, end);
    i = end + 1;
    const type = b.readInt32BE(i + 6);
    i += 18;
    out.push({ name, type });
  }
  return out;
}

function parseRow(b: Buffer, fields: Field[]): Record<string, unknown> {
  const n = b.readInt16BE(0);
  const row: Record<string, unknown> = {};
  let i = 2;
  for (let k = 0; k < n; k++) {
    const len = b.readInt32BE(i);
    i += 4;
    const f = fields[k]!;
    if (len === -1) { row[f.name] = null; continue; }
    const s = b.toString('utf8', i, i + len);
    i += len;
    row[f.name] = convert(s, f.type);
  }
  return row;
}

function convert(s: string, type: number): unknown {
  switch (type) {
    case 16: return s === 't';
    case 20: case 21: case 23: case 700: case 701: return Number(s);
    case 114: case 3802: return JSON.parse(s);
    case 1114: case 1184: return new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case 1009: return parseTextArray(s); // text[] — the real pg driver returns arrays too
    default: return s;
  }
}

/** Local Postgres with trust auth for the postgres user; override with TEST_PG_SOCKET. */
/** Parse a one-dimensional Postgres text[] literal, e.g. {a,"b c","d\\"e"}. */
function parseTextArray(s: string): string[] {
  const body = s.slice(1, -1);
  if (!body) return [];
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '\\') cur += body[++i] ?? '';
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
      wasQuoted = false;
    } else cur += ch;
  }
  out.push(!wasQuoted && cur === 'NULL' ? (null as unknown as string) : cur);
  return out;
}

export const TEST_SOCKET = process.env.TEST_PG_SOCKET ?? '/var/run/postgresql/.s.PGSQL.5432';

export async function connectTestDb(database: string): Promise<Db> {
  const main = await Conn.open(TEST_SOCKET, 'postgres', database);
  const q: Queryable = { query: (sql, params) => main.query(sql, params) };
  return {
    ...q,
    async tx(fn) {
      const c = await Conn.open(TEST_SOCKET, 'postgres', database);
      try {
        await c.query('BEGIN');
        const out = await fn({ query: (sql, params) => c.query(sql, params) });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.end();
      }
    },
    async close() { main.end(); },
  };
}

/** Create a fresh, empty database for one test file. */
export async function freshDatabase(name: string): Promise<Db> {
  const admin = await Conn.open(TEST_SOCKET, 'postgres', 'postgres');
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  admin.end();
  return connectTestDb(name);
}
