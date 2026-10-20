import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { utimes, writeFile, mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createPodcast, writeFeedContent } from '../src/db/podcasts.js';
import { parseFeed } from '../src/feed/parser.js';
import { createApp } from '../src/http/app.js';
import { podcastGuidFor } from '../src/import/importer.js';
import { cleanupUploads } from '../src/media/uploads.js';
import { announceDueEpisodes } from '../src/podping/podping.js';
import { FIXTURE, setupDb, tempDir, testConfig } from './support/env.js';
import { m4a, mp3, png } from './support/media-samples.js';

let db: Db;
let server: http.Server;
let base: string;
let mediaDir: string;
let config: ReturnType<typeof testConfig>;

class Client {
  cookie = '';
  async req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
    const raw = body instanceof Buffer;
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(method !== 'GET' ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: method === "GET" ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body ?? {}),
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
    return { status: res.status, json, text, headers: res.headers };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown, h?: Record<string, string>) => this.req('PUT', p, b, h);
  del = (p: string) => this.req('DELETE', p);

  /** Upload in small chunks, the way the dashboard does (but smaller, to exercise several). */
  async upload(podcastId: string, filename: string, body: Buffer, kind?: string, chunk = 64 * 1024) {
    const r = await this.post(`/api/podcasts/${podcastId}/uploads`, { filename, size: body.length, kind });
    assert.equal(r.status, 201, r.text);
    const id = r.json.upload.id;
    for (let off = 0; off < body.length; off += chunk) {
      const c = await this.put(`/api/podcasts/${podcastId}/uploads/${id}?offset=${off}`, body.subarray(off, off + chunk));
      assert.equal(c.status, 200, c.text);
    }
    const done = await this.post(`/api/podcasts/${podcastId}/uploads/${id}/complete`);
    assert.equal(done.status, 201, done.text);
    return done.json.media;
  }
}

const alice = new Client();
const bob = new Client();
let show: string;
let episode: string;
let audio: any;

const feed = async () => (await fetch(`${base}/garden-talk/feed.xml`)).text();
const diskPath = (url: string) => path.join(mediaDir, new URL(url).pathname);

before(async () => {
  db = await setupDb('feedhost_publish_test');
  mediaDir = await tempDir('publish-media');
  config = testConfig({
    mediaDir,
    publicBaseUrl: 'http://feeds.mine.test',
    mediaBaseUrl: 'http://feeds.mine.test',
  });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await alice.post('/api/auth/register', { email: 'alice@example.com', password: 'correct horse battery' })).status, 201);
  await db.query(`UPDATE site_settings SET allow_registration = true`);
  config.allowRegistration = true;
  assert.equal((await bob.post('/api/auth/register', { email: 'bob@example.com', password: 'correct horse battery' })).status, 201);
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

describe('starting a show from scratch', () => {
  test('alice creates a show; it gets a podcast:guid and a feed right away', async () => {
    const r = await alice.post('/api/podcasts', {
      title: 'Garden Talk',
      slug: 'garden-talk',
      description: 'Dirt under the nails.',
      author: 'Alice Green',
      ownerEmail: 'alice@example.com',
      categories: [{ text: 'Leisure', sub: ['Home & Garden'] }],
    });
    assert.equal(r.status, 201, r.text);
    show = r.json.podcast.id;
    assert.equal(r.json.podcast.feedUrl, 'http://feeds.mine.test/garden-talk/feed.xml');
    assert.equal(r.json.podcast.podcastGuid, podcastGuidFor('http://feeds.mine.test/garden-talk/feed.xml'));
    assert.equal(r.json.podcast.podping.enabled, true, 'nothing to move away from, so Podping starts on');

    const xml = await feed();
    assert.match(xml, /<title>Garden Talk<\/title>/);
    assert.match(xml, /<itunes:category text="Leisure">\s*<itunes:category text="Home &amp; Garden"\/>/);
    assert.match(xml, /<itunes:email>alice@example.com<\/itunes:email>/);
  });

  test('the checklist says what directories still need', async () => {
    const r = await alice.get(`/api/podcasts/${show}/details`);
    assert.equal(r.status, 200);
    const list = r.json.checklist.join('\n');
    assert.match(list, /artwork/);
    assert.match(list, /at least one episode/);
    assert.doesNotMatch(list, /category|owner email|author/i);
    assert.ok(r.json.categories.Leisure.includes('Home & Garden'));
  });

  test('feed addresses must be valid, free and not reserved', async () => {
    assert.equal((await alice.post('/api/podcasts', { title: 'X', slug: 'garden-talk' })).status, 409);
    assert.equal((await alice.post('/api/podcasts', { title: 'X', slug: 'api' })).status, 400);
    assert.equal((await alice.post('/api/podcasts', { title: 'X', slug: 'Bad Slug' })).status, 400);
    assert.equal((await alice.post('/api/podcasts', { slug: 'no-title' })).status, 400);
  });
});

describe('uploads', () => {
  test('chunked upload: wrong offsets are refused with where to continue, JSON chunks are refused', async () => {
    const body = mp3(1000);
    const r = await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'Episode 1.mp3', size: body.length });
    assert.equal(r.status, 201, r.text);
    const id = r.json.upload.id;
    assert.equal(r.json.upload.kind, 'audio');
    assert.equal(r.json.upload.chunkSize, 8 * 1024 * 1024);

    const json = await alice.req('PUT', `/api/podcasts/${show}/uploads/${id}?offset=0`, { not: 'bytes' });
    assert.equal(json.status, 415);
    const skip = await alice.put(`/api/podcasts/${show}/uploads/${id}?offset=5`, body.subarray(5, 10));
    assert.equal(skip.status, 409);
    assert.equal(skip.json.received, 0);

    assert.equal((await alice.put(`/api/podcasts/${show}/uploads/${id}?offset=0`, body.subarray(0, 100_000))).status, 200);
    // A retried chunk (same offset as before) after the first one landed: told to continue at 100000.
    const again = await alice.put(`/api/podcasts/${show}/uploads/${id}?offset=0`, body.subarray(0, 100_000));
    assert.equal(again.json.received, 100_000);
    const early = await alice.post(`/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(early.status, 409);
    assert.equal((await alice.get(`/api/podcasts/${show}/uploads/${id}`)).json.upload.received, 100_000);

    const tooMuch = await alice.put(`/api/podcasts/${show}/uploads/${id}?offset=100000`, Buffer.concat([body.subarray(100_000), Buffer.alloc(10)]));
    assert.equal(tooMuch.status, 413);
    assert.equal((await alice.put(`/api/podcasts/${show}/uploads/${id}?offset=100000`, body.subarray(100_000))).status, 200);
    const done = await alice.post(`/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(done.status, 201, done.text);
    audio = done.json.media;
    assert.equal(audio.kind, 'audio');
    assert.equal(audio.duration, 26);
    assert.equal(audio.bytes, body.length);
    assert.equal(audio.mimeType, 'audio/mpeg');
    assert.match(audio.url, /^http:\/\/feeds\.mine\.test\/garden-talk\/media\/audio\/[0-9a-f]{8}-Episode-1\.mp3$/);
    assert.ok(existsSync(diskPath(audio.url)));
  });

  test('unsupported or wrong-kind files are refused up front', async () => {
    assert.equal((await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'virus.exe', size: 10 })).status, 400);
    assert.equal((await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'a.mp3', size: 10, kind: 'image' })).status, 400);
    assert.equal((await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'huge.mp3', size: 60 * 1024 * 1024 })).status, 413);
    assert.equal((await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'chapters.txt', size: 10, kind: 'chapters' })).status, 400);
  });

  test('an image that isn’t one is refused when the upload finishes', async () => {
    const r = await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'art.png', size: 12 });
    const id = r.json.upload.id;
    await alice.put(`/api/podcasts/${show}/uploads/${id}?offset=0`, Buffer.from('hello world!'));
    const done = await alice.post(`/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(done.status, 400);
    assert.match(done.json.error, /isn’t a readable/);
  });

  test('show artwork: upload, save, and the checklist checks its size', async () => {
    const small = await alice.upload(show, 'small.png', png(600, 600));
    let r = await alice.put(`/api/podcasts/${show}/details`, { image: { mediaId: small.id } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.checklist.join(), /600 × 600/);
    const art = await alice.upload(show, 'art.png', png(3000, 3000));
    r = await alice.put(`/api/podcasts/${show}/details`, { image: { mediaId: art.id } });
    assert.doesNotMatch(r.json.checklist.join(), /artwork/i);
    assert.equal(r.json.show.imageUrl, art.url);
    // The replaced artwork was deleted.
    assert.ok(!existsSync(diskPath(small.url)));
    assert.match(await feed(), new RegExp(`<itunes:image href="${art.url}"/>`));
  });
});

describe('episodes', () => {
  test('a draft stays out of the feed, and can’t be published without audio', async () => {
    const r = await alice.post(`/api/podcasts/${show}/episodes`, { title: 'Tomatoes', description: '<p>Staking <b>tomatoes</b>.</p>' });
    assert.equal(r.status, 201, r.text);
    episode = r.json.episode.id;
    assert.equal(r.json.episode.status, 'draft');
    assert.equal(r.json.episode.inFeed, false);
    assert.match(r.json.episode.guid, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(await feed(), /Tomatoes/);

    const noAudio = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { status: 'published' });
    assert.equal(noAudio.status, 400);
    assert.match(noAudio.json.error, /audio/);
  });

  test('publishing now: the uploaded file, its size, type and length go into the feed', async () => {
    const r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, {
      enclosure: { mediaId: audio.id },
      status: 'published',
      season: 1,
      episode: 1,
      episodeType: 'full',
      explicit: false,
    });
    assert.equal(r.status, 200, r.text);
    const e = r.json.episode;
    assert.equal(e.status, 'published');
    assert.equal(e.inFeed, true);
    assert.equal(e.duration, 26);
    assert.equal(e.enclosure.mediaId, audio.id);

    const xml = await feed();
    assert.match(xml, new RegExp(`<enclosure url="${audio.url}" length="${audio.bytes}" type="audio/mpeg"/>`));
    assert.match(xml, /<itunes:duration>26<\/itunes:duration>/);
    assert.match(xml, /<description><!\[CDATA\[<p>Staking <b>tomatoes<\/b>.<\/p>\]\]><\/description>/);
    assert.match(xml, new RegExp(`<guid isPermaLink="false">${e.guid}</guid>`));
    // The file is served (with byte ranges) like imported media.
    const media = await fetch(base + new URL(audio.url).pathname, { headers: { Range: 'bytes=0-3' } });
    assert.equal(media.status, 206);
  });

  test('a newly published episode is announced through Podping once', async () => {
    await db.query(`DELETE FROM podping_queue`);
    assert.equal(await announceDueEpisodes(db, config), 1);
    assert.equal(await announceDueEpisodes(db, config), 0);
    const { rows } = await db.query(`SELECT reason FROM podping_queue WHERE podcast_id = $1 AND status = 'pending'`, [show]);
    assert.deepEqual(rows, [{ reason: 'update' }]);
  });

  test('editing a published episode updates the feed and pings', async () => {
    await db.query(`DELETE FROM podping_queue`);
    const r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { title: 'Staking tomatoes', duration: '1:02:03' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.episode.duration, 3723);
    assert.match(await feed(), /<title>Staking tomatoes<\/title>/);
    const { rows } = await db.query(`SELECT 1 FROM podping_queue WHERE podcast_id = $1`, [show]);
    assert.equal(rows.length, 1);
  });

  test('scheduling: a future date keeps it out of the feed until then', async () => {
    const at = new Date(Date.now() + 3 * 86400_000).toISOString();
    const r = await alice.post(`/api/podcasts/${show}/episodes`, {
      title: 'Garlic',
      enclosure: { url: 'https://cdn.example.com/garlic.m4a', length: 1234 },
      status: 'published',
      pubDate: at,
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.episode.status, 'scheduled');
    assert.equal(r.json.episode.inFeed, false);
    assert.equal(r.json.episode.enclosure.type, 'audio/x-m4a');
    assert.doesNotMatch(await feed(), /Garlic/);
    const list = (await alice.get(`/api/podcasts/${show}/episodes`)).json.episodes;
    assert.deepEqual(list.map((e: any) => [e.title, e.status]), [['Garlic', 'scheduled'], ['Staking tomatoes', 'published']]);
  });

  test('transcripts and chapters: uploaded, then listed in the feed', async () => {
    const vtt = await alice.upload(show, 'ep1.vtt', Buffer.from('WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n'));
    const chapters = await alice.upload(show, 'chapters.json', Buffer.from(JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro' }] })), 'chapters');
    assert.equal(vtt.mimeType, 'text/vtt');
    const r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, {
      transcripts: [{ mediaId: vtt.id, language: 'en', rel: 'captions' }, { url: 'https://example.com/t.html', type: 'text/html' }],
      chapters: { mediaId: chapters.id },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.episode.transcripts.length, 2);
    assert.equal(r.json.episode.chapters.url, chapters.url);
    const xml = await feed();
    assert.match(xml, new RegExp(`<podcast:transcript url="${vtt.url}" type="text/vtt" language="en" rel="captions"/>`));
    assert.match(xml, /<podcast:transcript url="https:\/\/example.com\/t.html" type="text\/html"\/>/);
    assert.match(xml, new RegExp(`<podcast:chapters url="${chapters.url}" type="application/json\\+chapters"/>`));

    const bad = await alice.upload(show, 'not-chapters.json', Buffer.from('{"hello":1}'));
    assert.equal(bad.kind, 'transcript', 'a .json without kind=chapters is a JSON transcript');
    const r2 = await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'x.json', size: 11, kind: 'chapters' });
    await alice.put(`/api/podcasts/${show}/uploads/${r2.json.upload.id}?offset=0`, Buffer.from('{"hello":1}'));
    assert.match((await alice.post(`/api/podcasts/${show}/uploads/${r2.json.upload.id}/complete`)).json.error, /no "chapters" list/);
  });

  test('other tags: any Podcasting 2.0 tag as XML, validated', async () => {
    const tags = '<podcast:license url="https://creativecommons.org/licenses/by/4.0/">cc-by-4.0</podcast:license>\n<podcast:soundbite startTime="73.0" duration="60.0">Best bit</podcast:soundbite>';
    let r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: tags });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.episode.otherTags, tags);
    let xml = await feed();
    assert.match(xml, /<podcast:license url="https:\/\/creativecommons.org\/licenses\/by\/4.0\/">cc-by-4.0<\/podcast:license>/);
    assert.match(xml, /<podcast:soundbite startTime="73.0" duration="60.0">Best bit<\/podcast:soundbite>/);
    // Transcripts are untouched by editing other tags.
    assert.match(xml, /podcast:transcript/);

    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: '<podcast:person>unclosed' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /isn’t valid XML/);
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: '<itunes:duration>10</itunes:duration>' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /own field \(Length\)/);
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: '<nope:thing/>' });
    assert.equal(r.status, 400);
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: 'loose text' });
    assert.equal(r.status, 400);

    // A new namespace declared on the element is added to the feed.
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: `${tags}\n<garden:zone xmlns:garden="https://garden.example/ns">7b</garden:zone>` });
    assert.equal(r.status, 200, r.text);
    xml = await feed();
    assert.match(xml, /xmlns:garden="https:\/\/garden.example\/ns"/);
    assert.match(xml, /<garden:zone>7b<\/garden:zone>/);
  });

  test('people: show-level hosts, episode-level people replace them for that episode', async () => {
    const photo = await alice.upload(show, 'alice.png', png(800, 800));
    let r = await alice.put(`/api/podcasts/${show}/details`, {
      people: [
        { name: 'Alice Green', role: 'host', group: 'cast', img: { mediaId: photo.id }, href: 'https://example.com/alice' },
        { name: 'Sam Reed', role: 'producer', group: 'creative direction' },
      ],
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.show.people.length, 2);
    assert.equal(r.json.show.people[0].img, photo.url);
    assert.doesNotMatch(r.json.show.otherTags, /podcast:person/);
    assert.ok(r.json.roles.Cast.includes('Guest'));

    // Episode: hosts plus a guest.
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, {
      people: [{ name: 'Alice Green', role: 'host', group: 'cast' }, { name: 'Dr. Ann Lee', role: 'guest', group: 'cast', href: 'https://example.com/ann' }],
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.episode.people.map((p: any) => [p.name, p.role]), [['Alice Green', 'host'], ['Dr. Ann Lee', 'guest']]);
    const xml = await feed();
    const channel = xml.slice(0, xml.indexOf('<item>'));
    const item = xml.slice(xml.indexOf('<item>'));
    assert.match(channel, new RegExp(`<podcast:person role="host" group="cast" img="${photo.url}" href="https://example.com/alice">Alice Green</podcast:person>`));
    assert.match(channel, /<podcast:person role="producer" group="creative direction">Sam Reed<\/podcast:person>/);
    assert.match(item, /<podcast:person role="guest" group="cast" href="https:\/\/example.com\/ann">Dr. Ann Lee<\/podcast:person>/);
    // Other fields and tags are untouched.
    assert.match(item, /podcast:soundbite/);
    assert.match(item, /podcast:transcript/);

    // People can't also be typed into Other tags, and names are required.
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: '<podcast:person>X</podcast:person>' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /own field \(People\)/);
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { people: [{ role: 'guest' }] });
    assert.equal(r.status, 400);
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { people: [{ name: 'X', href: 'javascript:alert(1)' }] });
    assert.equal(r.status, 400);

    // Back to the show's people: the episode lists none.
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { people: [] });
    assert.deepEqual(r.json.episode.people, []);
    assert.doesNotMatch((await feed()).slice((await feed()).indexOf('<item>')), /podcast:person/);
    // The photo is still used by the show, so it's kept.
    assert.ok(existsSync(diskPath(photo.url)));
  });

  test('locations: several per show and episode, with what they mean', async () => {
    let r = await alice.put(`/api/podcasts/${show}/details`, {
      locations: [{ name: 'Johns Creek, GA', rel: 'creator', geo: 'geo:34.0289,-84.1986', osm: 'r119557', country: 'us' }],
    });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.show.locations, [{ name: 'Johns Creek, GA', rel: 'creator', geo: 'geo:34.0289,-84.1986', osm: 'R119557', country: 'US' }]);
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, {
      locations: [
        { name: 'Atlanta Botanical Garden', rel: 'subject', geo: 'geo:33.7899,-84.3733', country: 'US' },
        { name: 'Marlow', rel: 'creator' },
      ],
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.episode.locations.length, 2);
    const xml = await feed();
    const channel = xml.slice(0, xml.indexOf('<item>'));
    assert.match(channel, /<podcast:location rel="creator" geo="geo:34.0289,-84.1986" osm="R119557" country="US">Johns Creek, GA<\/podcast:location>/);
    assert.match(xml, /<podcast:location rel="subject" geo="geo:33.7899,-84.3733" country="US">Atlanta Botanical Garden<\/podcast:location>/);
    assert.match(xml, /<podcast:location rel="creator">Marlow<\/podcast:location>/);
    // People and other tags are untouched.
    assert.match(xml, /Dr. Ann Lee|podcast:soundbite/);

    for (const bad of [{ rel: 'subject' }, { name: 'X', geo: '33.7,-84.3' }, { name: 'X', geo: 'geo:133.7,-84.3' }, { name: 'X', osm: '119557' }, { name: 'X', country: 'USA' }, { name: 'X', rel: 'about' }]) {
      r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { locations: [bad] });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { otherTags: '<podcast:location>X</podcast:location>' });
    assert.match(r.json.error, /own field \(Locations\)/);
  });

  test('place lookup fills in coordinates, OpenStreetMap ID and country', async () => {
    const seen: string[] = [];
    const osm = http.createServer((req, res) => {
      seen.push(`${req.url} ${req.headers['user-agent']}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([
        { lat: '30.2711286', lon: '-97.7436995', osm_type: 'relation', osm_id: 113314, name: 'Austin', display_name: 'Austin, Travis County, Texas, United States', address: { country_code: 'us' } },
        { lat: 'x', lon: '1' },
      ]));
    });
    await new Promise<void>((done) => osm.listen(0, '127.0.0.1', done));
    config.nominatimUrl = `http://127.0.0.1:${(osm.address() as AddressInfo).port}/`;
    try {
      const r = await alice.get('/api/places?q=Austin%2C%20TX');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.places, [{ name: 'Austin', label: 'Austin, Travis County, Texas, United States', geo: 'geo:30.2711286,-97.7436995', osm: 'R113314', country: 'US' }]);
      assert.match(seen[0]!, /^\/search\?q=Austin%2C\+TX&format=jsonv2/);
      assert.match(seen[0]!, /FeedHost\/0.1/);
      assert.equal((await alice.get('/api/places?q=')).status, 400);
    } finally {
      osm.close();
      config.nominatimUrl = 'http://127.0.0.1:1/';
    }
    const down = await alice.get('/api/places?q=Austin');
    assert.equal(down.status, 502);
    assert.match(down.json.error, /type the details in/);
  });

  test('replacing the audio deletes the old file', async () => {
    const next = await alice.upload(show, 'Episode 1 (fixed).m4a', m4a(1800));
    assert.equal(next.duration, 1800);
    const r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { enclosure: { mediaId: next.id } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.episode.duration, 1800, 'length follows the new file');
    assert.equal(r.json.episode.enclosure.type, 'audio/x-m4a');
    assert.ok(!existsSync(diskPath(audio.url)), 'old audio removed');
    assert.equal((await db.query(`SELECT 1 FROM media_files WHERE id = $1`, [audio.id])).rows.length, 0);
    audio = next;
  });

  test('unpublishing back to draft removes it from the feed and pings', async () => {
    await db.query(`DELETE FROM podping_queue`);
    const r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { status: 'draft' });
    assert.equal(r.json.episode.inFeed, false);
    assert.doesNotMatch(await feed(), /Staking tomatoes/);
    assert.equal((await db.query(`SELECT 1 FROM podping_queue WHERE podcast_id = $1`, [show])).rows.length, 1);
    // Publishing again keeps the original date and is announced again by the worker.
    const again = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { status: 'published' });
    assert.equal(again.json.episode.inFeed, true);
    assert.equal((await db.query(`SELECT announced_at FROM episodes WHERE id = $1`, [episode])).rows[0]!.announced_at, null);
  });
});

describe('editing an imported show', () => {
  let imported: string;
  test('editing one field keeps every other imported tag exactly', async () => {
    const owner = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'alice@example.com'`)).rows[0]!.id;
    imported = await createPodcast(db, { ownerId: owner, slug: 'imported-show', sourceUrl: 'https://old.example.com/feed.xml', title: 'x' });
    await writeFeedContent(db, imported, parseFeed(FIXTURE).feed);
    const before = await (await fetch(`${base}/imported-show/feed.xml`)).text();
    const list = (await alice.get(`/api/podcasts/${imported}/episodes`)).json.episodes;
    const first = (await alice.get(`/api/podcasts/${imported}/episodes/${list[list.length - 1].id}`)).json.episode;
    const r = await alice.patch(`/api/podcasts/${imported}/episodes/${first.id}`, { title: `${first.title} (edited)` });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.episode.otherTags, first.otherTags);
    assert.deepEqual(r.json.episode.transcripts, first.transcripts);
    const after = await (await fetch(`${base}/imported-show/feed.xml`)).text();
    const strip = (x: string) => x.replace(/<lastBuildDate>.*<\/lastBuildDate>/, '').replace(first.title + ' (edited)', first.title);
    assert.equal(strip(after), strip(before));
  });

  test('show details: other tags round-trip, live items are left alone', async () => {
    const d = (await alice.get(`/api/podcasts/${imported}/details`)).json;
    assert.ok(d.show.otherTags.length > 0);
    assert.doesNotMatch(d.show.otherTags, /liveItem/);
    const liveBefore = (await db.query(`SELECT count(*)::int AS n FROM tag_elements WHERE podcast_id = $1 AND name = 'liveItem'`, [imported])).rows[0];
    const r = await alice.put(`/api/podcasts/${imported}/details`, { otherTags: d.show.otherTags, title: 'Renamed' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.show.otherTags, d.show.otherTags);
    const liveAfter = (await db.query(`SELECT count(*)::int AS n FROM tag_elements WHERE podcast_id = $1 AND name = 'liveItem'`, [imported])).rows[0];
    assert.deepEqual(liveAfter, liveBefore);
    const bad = await alice.put(`/api/podcasts/${imported}/details`, { otherTags: '<podcast:liveItem status="live"/>' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Live tab/);
  });

  test('while a show is still importing, editing waits', async () => {
    await db.query(`UPDATE podcasts SET status = 'importing' WHERE id = $1`, [imported]);
    const list = (await alice.get(`/api/podcasts/${imported}/episodes`)).json.episodes;
    assert.equal((await alice.patch(`/api/podcasts/${imported}/episodes/${list[0].id}`, { title: 'x' })).status, 409);
    assert.equal((await alice.put(`/api/podcasts/${imported}/details`, { title: 'x' })).status, 409);
    await db.query(`UPDATE podcasts SET status = 'active' WHERE id = $1`, [imported]);
  });
});

describe('access', () => {
  test('other users get 404 everywhere; viewers can read but not change', async () => {
    for (const [m, p] of [
      ['GET', `/api/podcasts/${show}/episodes/${episode}`],
      ['PATCH', `/api/podcasts/${show}/episodes/${episode}`],
      ['POST', `/api/podcasts/${show}/episodes`],
      ['GET', `/api/podcasts/${show}/details`],
      ['POST', `/api/podcasts/${show}/uploads`],
      ['DELETE', `/api/podcasts/${show}/episodes/${episode}`],
    ] as const) {
      assert.equal((await bob.req(m, p, m === 'GET' ? undefined : { title: 'hacked', filename: 'a.mp3', size: 1 })).status, 404, `${m} ${p}`);
    }
    const bobId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email = 'bob@example.com'`)).rows[0]!.id;
    await db.query(`INSERT INTO podcast_members (podcast_id, user_id, role) VALUES ($1, $2, 'viewer')`, [show, bobId]);
    assert.equal((await bob.get(`/api/podcasts/${show}/episodes/${episode}`)).status, 200);
    assert.equal((await bob.patch(`/api/podcasts/${show}/episodes/${episode}`, { title: 'x' })).status, 403);
    assert.equal((await bob.post(`/api/podcasts/${show}/uploads`, { filename: 'a.mp3', size: 1 })).status, 403);
    assert.equal((await bob.put(`/api/podcasts/${show}/details`, { title: 'x' })).status, 403);
  });

  test('another show’s uploaded file can’t be attached', async () => {
    const other = (await bob.post('/api/podcasts', { title: 'Bob Show' })).json.podcast.id;
    const bobAudio = await bob.upload(other, 'b.mp3', mp3(50));
    const r = await alice.patch(`/api/podcasts/${show}/episodes/${episode}`, { enclosure: { mediaId: bobAudio.id } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /wasn’t found/);
  });
});

describe('cleaning up', () => {
  test('unused uploads can be removed; files in use can’t', async () => {
    const spare = await alice.upload(show, 'spare.png', png(1400, 1400));
    assert.equal((await alice.del(`/api/podcasts/${show}/media/${audio.id}`)).status, 409);
    assert.equal((await alice.del(`/api/podcasts/${show}/media/${spare.id}`)).status, 204);
    assert.ok(!existsSync(diskPath(spare.url)));
  });

  test('housekeeping drops abandoned uploads and old unused files', async () => {
    const r = await alice.post(`/api/podcasts/${show}/uploads`, { filename: 'half.mp3', size: 1000 });
    await alice.put(`/api/podcasts/${show}/uploads/${r.json.upload.id}?offset=0`, Buffer.alloc(500));
    const part = path.join(mediaDir, '.uploads', `${r.json.upload.id}.part`);
    assert.ok(existsSync(part));
    const orphan = await alice.upload(show, 'never-used.png', png(1400, 1400));
    await db.query(`UPDATE uploads SET updated_at = now() - interval '2 days'`);
    await db.query(`UPDATE media_files SET created_at = now() - interval '3 days'`);
    await mkdir(path.join(mediaDir, '.uploads'), { recursive: true });
    await writeFile(path.join(mediaDir, '.uploads', 'stray.part'), 'x');
    await utimes(part, new Date(0), new Date(0));

    await cleanupUploads(db, config);
    assert.ok(!existsSync(part));
    assert.ok(!existsSync(path.join(mediaDir, '.uploads', 'stray.part')));
    assert.ok(!existsSync(diskPath(orphan.url)), 'unused upload removed');
    assert.ok(existsSync(diskPath(audio.url)), 'the episode’s audio is kept');
  });

  test('deleting an episode removes it from the feed along with its files', async () => {
    const before = await alice.get(`/api/podcasts/${show}/episodes/${episode}`);
    const vttUrl = before.json.episode.transcripts[0].url;
    assert.equal((await alice.del(`/api/podcasts/${show}/episodes/${episode}`)).status, 204);
    assert.doesNotMatch(await feed(), /Staking tomatoes/);
    assert.ok(!existsSync(diskPath(audio.url)));
    assert.ok(!existsSync(diskPath(vttUrl)));
    assert.equal((await alice.get(`/api/podcasts/${show}/episodes/${episode}`)).status, 404);
    // The show artwork is still there.
    const art = (await alice.get(`/api/podcasts/${show}/details`)).json.show.imageUrl;
    assert.ok(existsSync(diskPath(art)));
  });
});
