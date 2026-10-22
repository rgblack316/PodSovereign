import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { setupDb, tempDir, testConfig } from './support/env.js';

let db: Db;
let server: http.Server;
let base: string;
const cookies: Record<string, string> = {};
const req = async (who: string, method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookies[who] ? { Cookie: cookies[who] } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookies[who] = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

before(async () => {
  db = await setupDb('podsovereign_usage_test');
  server = http.createServer(createApp({ db, config: testConfig({ mediaDir: await tempDir('usage') }) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await req('admin', 'POST', '/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
  await req('admin', 'POST', '/api/admin/users', { email: 'jimmy@example.com', password: 'correct horse battery', displayName: 'Coach Jimmy' });
  await req('jimmy', 'POST', '/api/auth/login', { email: 'jimmy@example.com', password: 'correct horse battery' });
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

test('Storage used: totals for the site, each account and each show (admins only)', async () => {
  const a = (await req('admin', 'POST', '/api/podcasts', { title: 'WVEdTalk', slug: 'wvedtalk' })).json.podcast.id;
  const b = (await req('admin', 'POST', '/api/podcasts', { title: 'Bible Bytes', slug: 'bible-bytes' })).json.podcast.id;
  const c = (await req('jimmy', 'POST', '/api/podcasts', { title: 'Shooting It Straight!', slug: 'sisp' })).json.podcast.id;
  const file = (pid: string, n: number, bytes: number, status = 'done') =>
    db.query(`INSERT INTO media_files (podcast_id, kind, original_url, status, bytes) VALUES ($1, 'audio', $2, $3, $4)`, [pid, `https://old.example.com/${pid}/${n}.mp3`, status, bytes]);
  await file(a, 1, 1_000_000); await file(a, 2, 2_000_000);
  await file(b, 1, 500_000); await file(b, 2, 9_999_999, 'failed');
  await file(c, 1, 4_000_000);

  assert.equal((await req('jimmy', 'GET', '/api/admin/storage-usage')).status, 403);
  const u = (await req('admin', 'GET', '/api/admin/storage-usage')).json;
  assert.deepEqual(u.total, { bytes: 7_500_000, files: 4, shows: 3, accounts: 2 });
  assert.deepEqual(u.accounts.map((x: any) => [x.email, x.shows, x.files, x.bytes]), [
    ['jimmy@example.com', 1, 1, 4_000_000],
    ['randy@example.com', 2, 3, 3_500_000],
  ]);
  assert.equal(u.accounts[0].name, 'Coach Jimmy');
  assert.deepEqual(u.shows.map((x: any) => [x.slug, x.bytes]), [['sisp', 4_000_000], ['wvedtalk', 3_000_000], ['bible-bytes', 500_000]]);
  // The show's own light uses the same number.
  assert.equal((await req('admin', 'GET', `/api/podcasts/${a}`)).json.podcast.media.bytes, 3_000_000);
});
