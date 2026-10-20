import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { loadFeed } from '../src/db/podcasts.js';
import { createApp } from '../src/http/app.js';
import { claimNextJob, runImportJob } from '../src/import/importer.js';
import { podpingEnabled, podpingMethod } from '../src/podping/podping.js';
import { sniffImage } from '../src/site/settings.js';
import { fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

let db: Db;
let server: http.Server;
let base: string;
let config: Config;
let host: Awaited<ReturnType<typeof startOldHost>>;

class Client {
  cookie = '';
  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      /* not json */
    }
    return { status: res.status, json, headers: res.headers, buf };
  }
  get = (p: string) => this.req('GET', p);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
  del = (p: string) => this.req('DELETE', p);
}

const admin = new Client();
const member = new Client();
const anon = new Client();

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
const dataUrl = (buf: Buffer, type = 'image/png') => `data:${type};base64,${buf.toString('base64')}`;

before(async () => {
  db = await setupDb('feedhost_site_test');
  host = await startOldHost();
  config = testConfig({
    mediaDir: await tempDir('site-media'),
    siteDir: await tempDir('site-assets'),
    allowRegistration: false,
    envDefaults: { publicBaseUrl: 'https://feeds.mine.test', mediaBaseUrl: null, allowRegistration: false, podpingToken: null, podpingMode: 'auto', cookieSecure: false },
  });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await admin.post('/api/auth/register', { email: 'admin@example.com', password: 'admin long password' });
  await admin.post('/api/admin/users', { email: 'member@example.com', password: 'member long password' });
  await member.post('/api/auth/login', { email: 'member@example.com', password: 'member long password' });
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await host.close();
  await db.close();
});

describe('name, logo and favicon', () => {
  test('only admins can see or change site settings', async () => {
    assert.equal((await member.get('/api/admin/site')).status, 403);
    assert.equal((await member.put('/api/admin/site', { siteName: 'Hijacked' })).status, 403);
    assert.equal((await member.post('/api/admin/site/logo', { dataUrl: dataUrl(PNG) })).status, 403);
    assert.equal((await anon.get('/api/admin/site')).status, 401);
    const r = await admin.get('/api/admin/site');
    assert.equal(r.status, 200);
    assert.equal(r.json.settings.siteName, 'FeedHost');
  });

  test('renaming the site', async () => {
    assert.equal((await admin.put('/api/admin/site', { siteName: '  ' })).status, 400);
    assert.equal((await admin.put('/api/admin/site', { siteName: 'x'.repeat(61) })).status, 400);
    const r = await admin.put('/api/admin/site', { siteName: 'Johns Creek Studios' });
    assert.equal(r.status, 200);
    const setup = (await anon.get('/api/setup')).json;
    assert.equal(setup.siteName, 'Johns Creek Studios');
    assert.ok(setup.siteVersion > 0);
  });

  test('image type is detected from the bytes', () => {
    assert.equal(sniffImage(PNG), 'image/png');
    assert.equal(sniffImage(JPEG), 'image/jpeg');
    assert.equal(sniffImage(ICO), 'image/x-icon');
    assert.equal(sniffImage(SVG), 'image/svg+xml');
    assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>')), null);
  });

  test('uploading a logo: accepted types only, served safely, removable', async () => {
    const before = (await anon.get('/site/logo'));
    assert.match(before.headers.get('content-type')!, /svg/, 'built-in icon until one is uploaded');

    const fake = await admin.post('/api/admin/site/logo', { dataUrl: dataUrl(Buffer.from('<html>not an image</html>')) });
    assert.equal(fake.status, 400);
    assert.match(fake.json.error, /PNG, JPEG, WebP or SVG/);
    const big = await admin.post('/api/admin/site/logo', { dataUrl: dataUrl(Buffer.concat([PNG, Buffer.alloc(1024 * 1024)])) });
    assert.equal(big.status, 400);
    assert.match(big.json.error, /1 MB/);

    const ok = await admin.post('/api/admin/site/logo', { dataUrl: dataUrl(SVG, 'image/svg+xml') });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.settings.hasLogo, true);
    const logo = await anon.get('/site/logo');
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
    assert.match(logo.headers.get('content-security-policy')!, /sandbox/, 'uploaded SVGs cannot run scripts');
    assert.ok(logo.buf.equals(SVG));

    const del = await admin.del('/api/admin/site/logo');
    assert.equal(del.json.settings.hasLogo, false);
    assert.ok(!(await anon.get('/site/logo')).buf.equals(SVG));
  });

  test('favicon accepts ICO/PNG/SVG but not JPEG', async () => {
    assert.equal((await admin.post('/api/admin/site/favicon', { dataUrl: dataUrl(JPEG, 'image/jpeg') })).status, 400);
    assert.equal((await admin.post('/api/admin/site/favicon', { dataUrl: dataUrl(ICO, 'image/x-icon') })).status, 200);
    const fav = await anon.get('/site/favicon');
    assert.equal(fav.headers.get('content-type'), 'image/x-icon');
    assert.ok(fav.buf.equals(ICO));
  });
});

describe('web address', () => {
  let podcastId: string;
  let slug: string;

  test('an imported show to move', async () => {
    host.files.set('/old/ep2.chapters.json', {
      type: 'application/json',
      body: JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro', img: `${host.base}/old/intro.jpg` }] }),
    });
    host.feeds.set('main', fixtureOn(host.base));
    const r = await admin.post('/api/imports', { url: `${host.base}/feeds/main.xml`, slug: 'creekside' });
    assert.equal(r.status, 202);
    await runImportJob({ db, config }, (await claimNextJob(db))!);
    podcastId = (await db.query<{ id: string }>(`SELECT id FROM podcasts`)).rows[0]!.id;
    slug = 'creekside';
    const feed = (await loadFeed(db, podcastId))!;
    assert.ok(feed.items[0]!.enclosureUrl!.startsWith('https://feeds.mine.test/creekside/media/'));
  });

  test('addresses must be a bare origin', async () => {
    for (const bad of ['podcasts.example.com', 'ftp://x.com', 'https://x.com/podcasts', 'https://x.com/?a=1', 'https://user:pw@x.com']) {
      const r = await admin.put('/api/admin/site', { publicBaseUrl: bad });
      assert.equal(r.status, 400, bad);
    }
    assert.equal(config.publicBaseUrl, 'https://feeds.mine.test', 'nothing changed');
  });

  test('changing the address moves every feed and media link, and remembers the old host', async () => {
    const r = await admin.put('/api/admin/site', { publicBaseUrl: 'https://podcasts.johnscreekstudios.com/' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.result, { addressChanged: true, rewrittenShows: 1 });
    assert.equal(r.json.settings.publicBaseUrl, 'https://podcasts.johnscreekstudios.com');
    assert.deepEqual(r.json.settings.previousHosts, ['feeds.mine.test']);

    const NEW = 'https://podcasts.johnscreekstudios.com/creekside/media/';
    const feed = (await loadFeed(db, podcastId))!;
    assert.ok(feed.channel.imageUrl!.startsWith(NEW));
    assert.ok(feed.items.every((it) => !it.enclosureUrl || it.enclosureUrl.startsWith(NEW)));
    const transcript = feed.items[0]!.extra.find((n) => n.name === 'podcast:transcript')!;
    assert.ok(transcript.attrs.url!.startsWith(NEW), 'tag attributes rewritten');
    assert.equal(feed.items[1]!.guid, `${host.base}/old/media/ep1.m4a`, 'GUIDs untouched');

    const { rows } = await db.query<{ storage_path: string }>(`SELECT storage_path FROM media_files WHERE kind = 'chapters' AND status = 'done'`);
    const chapters = JSON.parse(await readFile(rows[0]!.storage_path, 'utf8'));
    assert.ok(chapters.chapters[0].img.startsWith(NEW), 'chapter files rewritten');

    const xml = (await anon.get(`/${slug}/feed.xml`)).buf.toString();
    assert.ok(xml.includes('<atom:link href="https://podcasts.johnscreekstudios.com/creekside/feed.xml" rel="self"'));
    assert.ok(!xml.includes('feeds.mine.test'));
  });

  test('requests that still reach this server on the old hostname are redirected', async () => {
    const res = await new Promise<http.IncomingMessage>((resolve) =>
      http.get(`${base}/creekside/feed.xml?x=1`, { headers: { Host: 'feeds.mine.test' } }, resolve),
    );
    res.resume();
    assert.equal(res.statusCode, 301);
    assert.equal(res.headers.location, 'https://podcasts.johnscreekstudios.com/creekside/feed.xml?x=1');
  });

  test('CSRF checks follow the new address', async () => {
    const r = await admin.req('PUT', '/api/admin/site', { siteName: 'X' }, { Origin: 'https://feeds.mine.test' });
    assert.equal(r.status, 403, 'the old origin is no longer trusted');
    const ok = await admin.req('PUT', '/api/admin/site', { siteName: 'Johns Creek Studios' }, { Origin: 'https://podcasts.johnscreekstudios.com' });
    assert.equal(ok.status, 200);
  });

  test('a separate media address (for a CDN) moves only media links', async () => {
    const r = await admin.put('/api/admin/site', { mediaBaseUrl: 'https://media.johnscreekstudios.com' });
    assert.equal(r.status, 200);
    const feed = (await loadFeed(db, podcastId))!;
    assert.ok(feed.items[0]!.enclosureUrl!.startsWith('https://media.johnscreekstudios.com/creekside/media/'));
    const xml = (await anon.get(`/${slug}/feed.xml`)).buf.toString();
    assert.ok(xml.includes('<atom:link href="https://podcasts.johnscreekstudios.com/creekside/feed.xml"'), 'feed address unchanged');

    await admin.put('/api/admin/site', { mediaBaseUrl: '' });
    const back = (await loadFeed(db, podcastId))!;
    assert.ok(back.items[0]!.enclosureUrl!.startsWith('https://podcasts.johnscreekstudios.com/creekside/media/'), 'blank = same as site');
  });
});

describe('sign-ups and Podping key', () => {
  test('opening sign-ups from the panel', async () => {
    const closed = await new Client().post('/api/auth/register', { email: 'new@example.com', password: 'a long password!' });
    assert.equal(closed.status, 403);
    await admin.put('/api/admin/site', { allowRegistration: true });
    assert.equal((await anon.get('/api/setup')).json.registrationOpen, true);
    const open = await new Client().post('/api/auth/register', { email: 'new@example.com', password: 'a long password!' });
    assert.equal(open.status, 201);
    assert.equal((await admin.put('/api/admin/site', { allowRegistration: 'yes' })).status, 400);
    await admin.put('/api/admin/site', { allowRegistration: false });
  });

  test('the Podping key is saved but never sent back', async () => {
    assert.equal(podpingMethod(config), 'hub', 'no key: the Podcast Index hub');
    const r = await admin.put('/api/admin/site', { podpingKey: 'secret-key-123' });
    assert.equal(r.json.settings.podpingKeySet, true);
    assert.ok(!JSON.stringify(r.json).includes('secret-key-123'));
    assert.equal(podpingMethod(config), 'cloud');
    assert.equal(config.podpingToken, 'secret-key-123');
    await admin.put('/api/admin/site', { podpingKey: null });
    assert.equal(podpingMethod(config), 'hub');
  });

  test('the Podping method can be chosen, including off', async () => {
    let r = await admin.put('/api/admin/site', { podpingMode: 'off' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.settings.podpingMode, 'off');
    assert.equal(r.json.settings.podpingMethod, null);
    assert.equal(podpingEnabled(config), false);
    r = await admin.put('/api/admin/site', { podpingMode: 'cloud' });
    assert.equal(r.json.settings.podpingMethod, null, 'podping.cloud without a key sends nothing');
    assert.equal((await admin.put('/api/admin/site', { podpingMode: 'sometimes' })).status, 400);
    r = await admin.put('/api/admin/site', { podpingMode: 'auto' });
    assert.equal(r.json.settings.podpingMethod, 'hub');
  });

  test('"site" is reserved as a show address', async () => {
    const r = await admin.post('/api/imports', { url: 'https://x.example/feed.xml', slug: 'site' });
    assert.equal(r.status, 400);
  });
});
