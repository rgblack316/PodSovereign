import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { setupDb, tempDir, testConfig } from './support/env.js';
import { png } from './support/media-samples.js';

let db: Db;
let server: http.Server;
let base: string;
let mediaDir: string;

class Client {
  cookie = '';
  async req(method: string, p: string, body?: unknown) {
    const raw = body instanceof Buffer;
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(method !== 'GET' ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
      },
      body: method === 'GET' ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  del = (p: string, b?: unknown) => this.req('DELETE', p, b ?? {});
  login = (email: string) => this.post('/api/auth/login', { email, password: 'correct horse battery' });
}

const alice = new Client(); // admin
const bob = new Client();
const carol = new Client();
const dave = new Client();
const ids: Record<string, string> = {};
let show: string;

before(async () => {
  db = await setupDb('feedhost_team_test');
  mediaDir = await tempDir('team-media');
  const config = testConfig({ mediaDir, allowRegistration: false, publicBaseUrl: 'http://feeds.mine.test', mediaBaseUrl: 'http://feeds.mine.test' });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ids.alice = (await alice.post('/api/auth/register', { email: 'alice@example.com', password: 'correct horse battery' })).json.user.id;
  for (const [name, c] of [['bob', bob], ['carol', carol], ['dave', dave]] as const) {
    const r = await alice.post('/api/admin/users', { email: `${name}@example.com`, password: 'correct horse battery', displayName: name });
    assert.equal(r.status, 201, r.text);
    ids[name] = r.json.user.id;
    assert.equal((await c.login(`${name}@example.com`)).status, 200);
  }
  show = (await alice.post('/api/podcasts', { title: 'Garden Talk', slug: 'garden-talk' })).json.podcast.id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

describe('a show’s team', () => {
  test('the owner adds people by email, as editors or viewers', async () => {
    let r = await alice.get(`/api/podcasts/${show}/team`);
    assert.deepEqual(r.json.team.map((m: any) => [m.email, m.role]), [['alice@example.com', 'owner']]);

    r = await alice.post(`/api/podcasts/${show}/team`, { email: ' Bob@Example.com ', role: 'editor' });
    assert.equal(r.status, 201, r.text);
    r = await alice.post(`/api/podcasts/${show}/team`, { email: 'carol@example.com', role: 'viewer' });
    assert.deepEqual(r.json.team.map((m: any) => [m.email, m.role]), [
      ['alice@example.com', 'owner'], ['bob@example.com', 'editor'], ['carol@example.com', 'viewer'],
    ]);

    assert.equal((await alice.post(`/api/podcasts/${show}/team`, { email: 'nobody@example.com', role: 'editor' })).status, 404);
    assert.equal((await alice.post(`/api/podcasts/${show}/team`, { email: 'bob@example.com', role: 'viewer' })).status, 409);
    assert.equal((await alice.post(`/api/podcasts/${show}/team`, { email: 'alice@example.com', role: 'editor' })).status, 400);
    assert.equal((await alice.post(`/api/podcasts/${show}/team`, { email: 'dave@example.com', role: 'owner' })).status, 400);
  });

  test('editors can publish, viewers can only look, and only the owner manages the team', async () => {
    const list = (await bob.get('/api/podcasts')).json.podcasts;
    assert.deepEqual(list.map((p: any) => [p.title, p.role]), [['Garden Talk', 'editor']]);
    assert.equal((await bob.post(`/api/podcasts/${show}/episodes`, { title: 'By Bob' })).status, 201);
    assert.equal((await carol.post(`/api/podcasts/${show}/episodes`, { title: 'By Carol' })).status, 403);
    assert.equal((await carol.get(`/api/podcasts/${show}/team`)).status, 200);
    assert.equal((await bob.post(`/api/podcasts/${show}/team`, { email: 'dave@example.com', role: 'editor' })).status, 403);
    assert.equal((await bob.del(`/api/podcasts/${show}/team/${ids.carol}`)).status, 403);
    assert.equal((await bob.del(`/api/podcasts/${show}`)).status, 403);
    // Outsiders still can't tell the show exists.
    assert.equal((await dave.get(`/api/podcasts/${show}/team`)).status, 404);
  });

  test('roles change; ownership can be handed over and the old owner stays as an editor', async () => {
    assert.equal((await alice.patch(`/api/podcasts/${show}/team/${ids.carol}`, { role: 'editor' })).status, 200);
    assert.equal((await alice.patch(`/api/podcasts/${show}/team/${ids.dave}`, { role: 'editor' })).status, 404);
    const r = await alice.patch(`/api/podcasts/${show}/team/${ids.bob}`, { role: 'owner' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.team.map((m: any) => [m.email, m.role]), [
      ['bob@example.com', 'owner'], ['alice@example.com', 'editor'], ['carol@example.com', 'editor'],
    ]);
    assert.equal((await alice.post(`/api/podcasts/${show}/team`, { email: 'dave@example.com', role: 'viewer' })).status, 403);
  });

  test('a member can leave; afterwards the show is gone from their list', async () => {
    assert.equal((await carol.del(`/api/podcasts/${show}/team/${ids.carol}`)).status, 204);
    assert.equal((await carol.get(`/api/podcasts/${show}`)).status, 404);
    assert.deepEqual((await carol.get('/api/podcasts')).json.podcasts, []);
  });
});

describe('deleting accounts', () => {
  test('only admins; never yourself', async () => {
    assert.equal((await bob.del(`/api/admin/users/${ids.carol}`)).status, 403);
    assert.equal((await alice.del(`/api/admin/users/${ids.alice}`)).status, 400);
    assert.equal((await alice.del('/api/admin/users/not-a-uuid')).status, 404);
  });

  test('the People list shows each account’s shows and roles', async () => {
    const users = (await alice.get('/api/admin/users')).json.users;
    const bobRow = users.find((u: any) => u.email === 'bob@example.com');
    assert.deepEqual(bobRow.shows.map((s: any) => [s.title, s.role]), [['Garden Talk', 'owner']]);
    assert.equal(users.find((u: any) => u.email === 'alice@example.com').shows[0].role, 'editor');
  });

  test('an account that owns shows: the admin must choose; handing them over works', async () => {
    let r = await alice.del(`/api/admin/users/${ids.bob}`);
    assert.equal(r.status, 409);
    assert.match(r.json.error, /Garden Talk/);
    r = await alice.del(`/api/admin/users/${ids.bob}`, { shows: 'transfer', transferTo: ids.bob });
    assert.equal(r.status, 400);
    await db.query(`INSERT INTO import_jobs (user_id, source_url) VALUES ($1, 'https://x.example/feed.xml')`, [ids.bob]);
    r = await alice.del(`/api/admin/users/${ids.bob}`, { shows: 'transfer', transferTo: ids.carol });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { deletedShows: 0, transferred: 1 });
    assert.equal((await carol.get(`/api/podcasts/${show}`)).json.podcast.role, 'owner');
    assert.equal((await bob.get('/api/me')).status, 401, 'signed out');
    assert.equal((await bob.login('bob@example.com')).status, 401, 'account gone');
    // Alice keeps her editor access.
    assert.equal((await alice.get(`/api/podcasts/${show}`)).json.podcast.role, 'editor');
  });

  test('or their shows are deleted, files and all', async () => {
    const own = (await dave.post('/api/podcasts', { title: 'Dave Show' })).json.podcast;
    const up = await dave.post(`/api/podcasts/${own.id}/uploads`, { filename: 'art.png', size: 64 });
    await dave.req('PUT', `/api/podcasts/${own.id}/uploads/${up.json.upload.id}?offset=0`, png(1400, 1400));
    const media = (await dave.post(`/api/podcasts/${own.id}/uploads/${up.json.upload.id}/complete`)).json.media;
    const file = path.join(mediaDir, new URL(media.url).pathname);
    assert.ok(existsSync(file));
    const r = await alice.del(`/api/admin/users/${ids.dave}`, { shows: 'delete' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.deletedShows, 1);
    assert.ok(!existsSync(file));
    assert.equal((await fetch(`${base}/dave-show/feed.xml`)).status, 404);
  });
});

describe('administrators', () => {
  test('admin access can be given and taken, but never leaves the site without one', async () => {
    assert.equal((await alice.patch(`/api/admin/users/${ids.alice}`, { isAdmin: false })).status, 400, 'not your own');
    assert.equal((await alice.patch(`/api/admin/users/${ids.carol}`, { isAdmin: true })).status, 204);
    assert.equal((await carol.get('/api/admin/users')).status, 200);
    assert.equal((await carol.patch(`/api/admin/users/${ids.alice}`, { isAdmin: false })).status, 204);
    assert.equal((await alice.get('/api/admin/users')).status, 403);
    // Carol is now the only admin: she can't delete herself or drop her own access.
    assert.equal((await carol.del(`/api/admin/users/${ids.carol}`, { shows: 'delete' })).status, 400);
    assert.equal((await carol.patch(`/api/admin/users/${ids.carol}`, { isAdmin: false })).status, 400);
  });
});
