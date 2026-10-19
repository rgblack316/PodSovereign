import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { freshDatabase } from './pgwire.js';

export const FIXTURE = readFileSync(new URL('../fixtures/full-feed.xml', import.meta.url), 'utf8');
const SCRATCH = fileURLToPath(new URL('../../.scratch/', import.meta.url));

export async function setupDb(name: string): Promise<Db> {
  const db = await freshDatabase(name);
  await migrate(db);
  return db;
}

export async function tempDir(name: string): Promise<string> {
  const dir = `${SCRATCH}${name}-${process.pid}`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    databaseUrl: '',
    publicBaseUrl: 'https://feeds.mine.test',
    mediaDir: '',
    cookieSecure: false,
    allowRegistration: true,
    allowPrivateNetworks: true,
    maxFeedBytes: 5 * 1024 * 1024,
    maxMediaBytes: 50 * 1024 * 1024,
    downloadConcurrency: 3,
    sessionDays: 30,
    ...over,
  };
}

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/x-m4a', mp4: 'video/mp4', jpg: 'image/jpeg',
  vtt: 'text/vtt', srt: 'application/x-subrip', json: 'application/json',
};

/** Fake "old host": serves feeds at /feeds/<name>.xml and any file under /old/. */
export async function startOldHost(): Promise<{
  base: string;
  hits: Map<string, number>;
  feeds: Map<string, string>;
  missing: Set<string>;
  /** Custom bodies for specific /old/ paths. */
  files: Map<string, { type: string; body: string }>;
  close: () => Promise<void>;
}> {
  const files = new Map<string, { type: string; body: string }>();
  const hits = new Map<string, number>();
  const feeds = new Map<string, string>();
  const missing = new Set<string>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.set(url, (hits.get(url) ?? 0) + 1);
    if (url === '/moved.xml') {
      res.writeHead(301, { Location: '/feeds/main.xml' }).end();
      return;
    }
    const feed = /^\/feeds\/(.+)\.xml$/.exec(url);
    if (feed && feeds.has(feed[1]!)) {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' }).end(feeds.get(feed[1]!));
      return;
    }
    const custom = files.get(url.split('?')[0]!);
    if (custom) {
      res.writeHead(200, { 'Content-Type': custom.type }).end(custom.body);
      return;
    }
    if (url.startsWith('/old/') && !missing.has(url)) {
      const ext = url.split('.').pop() ?? '';
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }).end(`content of ${url}`);
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits, feeds, missing, files, close: () => new Promise((r) => server.close(() => r())) };
}

/** The fixture feed, re-pointed at the fake old host. */
export function fixtureOn(base: string, edit: (xml: string) => string = (x) => x): string {
  return edit(
    FIXTURE.replace(
      'https://op3.dev/e/dts.podtrac.com/redirect.mp3/chtbl.com/track/ABC123/oldhost.example.com/media/ep2.mp3',
      'https://oldhost.example.com/media/ep2.mp3',
    ).replaceAll('https://oldhost.example.com/', `${base}/old/`),
  );
}

export async function createUser(db: Db, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  );
  return rows[0]!.id;
}
