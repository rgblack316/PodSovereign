import assert from 'node:assert/strict';
import { readFile, utimes, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { setupDb, tempDir, testConfig } from './support/env.js';

let db: Db;
let server: http.Server;
let gh: http.Server;
let base: string;
let control: string;
let cookie = '';
const github = { status: 200, body: {} as unknown, hits: [] as string[] };

async function req(method: string, p: string, body?: unknown, auth = true) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}
const heartbeat = async (ageSec = 0) => {
  const f = path.join(control, 'watcher.alive');
  await writeFile(f, 'x');
  const t = new Date(Date.now() - ageSec * 1000);
  await utimes(f, t, t);
};

before(async () => {
  db = await setupDb('podsovereign_update_test');
  control = await tempDir('update-control');
  gh = http.createServer((r, res) => {
    github.hits.push(r.url ?? '');
    res.writeHead(github.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(github.body));
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
  const config = testConfig({ controlDir: control, githubApiUrl: `http://127.0.0.1:${(gh.address() as AddressInfo).port}`, githubRepo: 'rgblack316/podsovereign' });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.FEEDHOST_VERSION = 'abc1234';
  await req('POST', '/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' });
});
after(async () => {
  delete process.env.FEEDHOST_VERSION;
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => gh.close(() => r()));
  await db.close();
});

test('only a signed-in admin can see or start updates', async () => {
  assert.equal((await req('GET', '/api/admin/update', undefined, false)).status, 401);
  assert.equal((await req('POST', '/api/admin/update/apply', {}, false)).status, 401);
});

test('checking GitHub lists what is new, newest first, and compares this build’s commit', async () => {
  github.body = { ahead_by: 2, commits: [{ sha: 'aaaaaaa1111', commit: { message: 'Older change\n\nmore text' } }, { sha: 'bbbbbbb2222', commit: { message: 'Newer change' } }] };
  const r = await req('POST', '/api/admin/update/check');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.check.changes, ['Newer change', 'Older change']);
  assert.equal(r.json.check.updateAvailable, true);
  assert.equal(r.json.check.behindBy, 2);
  assert.equal(r.json.check.latest, 'bbbbbbb');
  assert.equal(r.json.check.current, 'abc1234');
  assert.match(github.hits.at(-1)!, /^\/repos\/rgblack316\/podsovereign\/compare\/abc1234\.\.\.main$/);
});

test('up to date, a build GitHub doesn’t know, and an unreachable GitHub each say so', async () => {
  github.body = { ahead_by: 0, commits: [] };
  let r = await req('POST', '/api/admin/update/check');
  assert.equal(r.json.check.updateAvailable, false);
  assert.equal(r.json.check.error, null);

  github.status = 404;
  r = await req('POST', '/api/admin/update/check');
  assert.match(r.json.check.error, /isn’t on GitHub/);
  assert.equal(r.json.check.updateAvailable, false);

  github.status = 200;
  process.env.FEEDHOST_VERSION = 'dev';
  github.body = 'cccccccdddddddd';
  r = await req('POST', '/api/admin/update/check');
  assert.equal(r.json.check.known, false);
  process.env.FEEDHOST_VERSION = 'abc1234';
});

test('Update now needs the updater service; with it, a request is left for it and asking again waits', async () => {
  let r = await req('POST', '/api/admin/update/apply');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /install-updater/);

  await heartbeat(600);
  assert.equal((await req('POST', '/api/admin/update/apply')).status, 409, 'a heartbeat from ten minutes ago means it is not running');

  await heartbeat();
  r = await req('POST', '/api/admin/update/apply');
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.queued, true);
  assert.equal(r.json.state.state, 'queued');
  assert.equal(r.json.state.watcherAlive, true);
  assert.equal(typeof r.json.check.current, 'string', 'the answer carries the version check too, since the page redraws from it');
  const asked = JSON.parse(await readFile(path.join(control, 'upgrade.request'), 'utf8'));
  assert.equal(asked.requested_by, 'randy@example.com');

  r = await req('POST', '/api/admin/update/apply');
  assert.equal(r.status, 200);
  assert.equal(r.json.queued, false, 'one is already waiting');
});

test('progress written by the updater service is shown', async () => {
  await writeFile(path.join(control, 'upgrade.status'), JSON.stringify({ state: 'running', message: 'Updating.', started_at: '2026-11-28T12:00:00+00:00', revision_before: 'abc1234' }));
  let r = await req('GET', '/api/admin/update');
  assert.equal(r.json.state.state, 'running');
  assert.equal(r.json.state.revisionBefore, 'abc1234');

  await writeFile(path.join(control, 'upgrade.status'), JSON.stringify({ state: 'success', message: 'Update complete.', finished_at: '2026-11-28T12:02:00+00:00', revision_before: 'abc1234', revision_after: 'def5678' }));
  r = await req('GET', '/api/admin/update');
  assert.equal(r.json.state.state, 'success');
  assert.equal(r.json.state.revisionAfter, 'def5678');

  // A finished update can be followed by another one.
  assert.equal((await req('POST', '/api/admin/update/apply')).status, 202);
});

test('a control folder that can’t be written to says one-click updates aren’t available', async () => {
  const blocked = await tempDir('update-blocked');
  await writeFile(path.join(blocked, 'file'), 'x');
  const cfg = testConfig({ controlDir: path.join(blocked, 'file', 'control'), githubApiUrl: 'http://127.0.0.1:1' });
  const s = http.createServer(createApp({ db, config: cfg }));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/admin/update`, { headers: { Cookie: cookie } });
  const j: any = await res.json();
  assert.equal(j.state.available, false);
  await new Promise<void>((r) => s.close(() => r()));
  await mkdir(blocked, { recursive: true });
});
