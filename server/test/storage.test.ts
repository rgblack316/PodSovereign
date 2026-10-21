import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { loadFeed } from '../src/db/podcasts.js';
import { createApp } from '../src/http/app.js';
import { claimNextJob, runImportJob } from '../src/import/importer.js';
import { BunnyClient } from '../src/storage/bunny.js';
import { claimMove, runMove } from '../src/storage/move.js';
import { PROVIDERS, toClient, validateSettings } from '../src/storage/providers.js';
import { S3Client, signV4, uriEncode } from '../src/storage/s3.js';
import { testConnection } from '../src/storage/store.js';
import { startFakeBunny, startFakeS3, type FakeBunny, type FakeS3 } from './support/fake-storage.js';
import { fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

const S3_CREDS = { bucket: 'pods', accessKeyId: 'AKTEST', secret: 'sekret/with+chars', region: 'us-east-1' };

describe('AWS Signature V4', () => {
  const common = {
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    host: 'examplebucket.s3.amazonaws.com',
  };

  test('matches AWS’s published GET Object example', () => {
    const h = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const { authorization } = signV4({
      ...common,
      method: 'GET',
      path: '/test.txt',
      payloadHash: h,
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': h, 'x-amz-date': '20130524T000000Z' },
    });
    assert.equal(
      authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  test('matches AWS’s published PUT Object example (with $ in the key)', () => {
    const h = '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072';
    const { authorization } = signV4({
      ...common,
      method: 'PUT',
      path: `/${uriEncode('test$file.text', true)}`,
      payloadHash: h,
      headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-date': '20130524T000000Z', 'x-amz-storage-class': 'REDUCED_REDUNDANCY', 'x-amz-content-sha256': h },
    });
    assert.ok(authorization.endsWith('Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd'));
  });

  test('URI encoding follows RFC 3986', () => {
    assert.equal(uriEncode("a b!'()*~._-"), 'a%20b%21%27%28%29%2A~._-');
    assert.equal(uriEncode('show/media/audio/ep 1.mp3', true), 'show/media/audio/ep%201.mp3');
  });
});

describe('provider settings', () => {
  test('every provider is offered with its fields', () => {
    assert.deepEqual(PROVIDERS.map((p) => p.id), ['r2', 'b2', 's3', 'wasabi', 'spaces', 'bunny', 'other']);
    for (const p of PROVIDERS) assert.ok(p.fields.some((f) => f.type === 'secret'), `${p.id} has a secret field`);
  });

  test('validation catches missing and malformed values', () => {
    const r2 = { accountId: 'a'.repeat(32), accessKeyId: 'k', bucket: 'my-bucket', publicUrl: 'https://media.example.com/' };
    assert.equal(validateSettings('r2', r2, 's').publicUrl, 'https://media.example.com');
    assert.throws(() => validateSettings('r2', r2, null), /Secret access key is required/);
    assert.throws(() => validateSettings('r2', { ...r2, accountId: 'nope' }, 's'), /Account ID is 32/);
    assert.throws(() => validateSettings('r2', { ...r2, bucket: 'Bad Bucket!' }, 's'), /bucket name/);
    assert.throws(() => validateSettings('r2', { ...r2, publicUrl: '' }, 's'), /Public address is required/);
    assert.throws(() => validateSettings('wasabi', { region: 'mars-1', accessKeyId: 'k', bucket: 'b-1', publicUrl: 'https://x.com' }, 's'), /from the list/);
    assert.throws(() => validateSettings('nope', {}, 's'), /Choose a storage provider/);
  });

  test('each provider connects to the right endpoint', () => {
    const cfg = (id: string, s: Record<string, string | boolean>) => (toClient(id, s, 'secret') as unknown as { cfg: Record<string, unknown> }).cfg;
    assert.deepEqual(
      { endpoint: cfg('r2', { accountId: 'abc', bucket: 'b' }).endpoint, region: cfg('r2', { accountId: 'abc', bucket: 'b' }).region },
      { endpoint: 'https://abc.r2.cloudflarestorage.com', region: 'auto' },
    );
    assert.equal(cfg('b2', { endpoint: 's3.us-west-004.backblazeb2.com', bucket: 'b' }).region, 'us-west-004');
    assert.equal(cfg('b2', { endpoint: 's3.us-west-004.backblazeb2.com', bucket: 'b' }).endpoint, 'https://s3.us-west-004.backblazeb2.com');
    assert.equal(cfg('s3', { region: 'eu-west-2', bucket: 'b' }).endpoint, 'https://s3.eu-west-2.amazonaws.com');
    assert.equal(cfg('s3', { region: 'eu-west-2', bucket: 'b' }).pathStyle, false);
    assert.equal(cfg('wasabi', { region: 'eu-central-2', bucket: 'b' }).endpoint, 'https://s3.eu-central-2.wasabisys.com');
    const spaces = cfg('spaces', { region: 'sfo3', bucket: 'b' });
    assert.deepEqual([spaces.endpoint, spaces.region, spaces.acl], ['https://sfo3.digitaloceanspaces.com', 'sfo3', 'public-read']);
    const bunny = (toClient('bunny', { zone: 'z', hostname: 'ny.storage.bunnycdn.com' }, 'pw') as unknown as { cfg: Record<string, unknown> }).cfg;
    assert.deepEqual(bunny, { hostname: 'ny.storage.bunnycdn.com', zone: 'z', password: 'pw' });
  });

  test('virtual-hosted vs path-style addressing', () => {
    const t = (pathStyle: boolean) =>
      (new S3Client({ endpoint: 'https://s3.example.com', region: 'r', bucket: 'bk', accessKeyId: 'a', secretAccessKey: 's', pathStyle }) as unknown as {
        target(k: string): { host: string; path: string };
      }).target('show/media/audio/ep 1.mp3');
    assert.deepEqual(t(true), { host: 's3.example.com', path: '/bk/show/media/audio/ep%201.mp3' });
    assert.deepEqual(t(false), { host: 'bk.s3.example.com', path: '/show/media/audio/ep%201.mp3' });
  });
});

describe('S3 client against a signature-checking server', () => {
  let s3: FakeS3;
  let client: S3Client;
  let dir: string;
  before(async () => {
    s3 = await startFakeS3(S3_CREDS);
    dir = await tempDir('s3-client');
    client = new S3Client({
      endpoint: s3.endpoint, region: S3_CREDS.region, bucket: S3_CREDS.bucket, accessKeyId: S3_CREDS.accessKeyId,
      secretAccessKey: S3_CREDS.secret, pathStyle: true, multipartThreshold: 1024 * 1024, minPartSize: 256 * 1024,
    });
  });
  after(() => s3.close());

  test('put, get, list (paginated) and delete — every request correctly signed', async () => {
    await client.putBuffer('show/media/images/a b+c.jpg', Buffer.from('img'), 'image/jpeg');
    await client.putBuffer('show/media/audio/1.mp3', Buffer.from('one'), 'audio/mpeg');
    await client.putBuffer('show/media/audio/2.mp3', Buffer.from('two'), 'audio/mpeg');
    await client.putBuffer('other/x.txt', Buffer.from('x'), 'text/plain');
    assert.equal((await client.getBuffer('show/media/images/a b+c.jpg')).toString(), 'img');
    assert.equal(s3.objects.get('show/media/images/a b+c.jpg')!.type, 'image/jpeg');
    assert.deepEqual((await client.list('show/')).sort(), ['show/media/audio/1.mp3', 'show/media/audio/2.mp3', 'show/media/images/a b+c.jpg']);
    assert.equal(await client.deletePrefix('show/'), 3);
    assert.deepEqual([...s3.objects.keys()], ['other/x.txt']);
  });

  test('large files go up in parts and come back intact', async () => {
    const big = Buffer.alloc(1024 * 1024 + 300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
    const f = path.join(dir, 'big.bin');
    await writeFile(f, big);
    const before = s3.multipartUploads;
    await client.putFile('show/media/audio/big.mp3', f, big.length, 'audio/mpeg');
    assert.equal(s3.multipartUploads, before + 1);
    assert.ok(s3.objects.get('show/media/audio/big.mp3')!.body.equals(big));
    const back = path.join(dir, 'back.bin');
    await client.getToFile('show/media/audio/big.mp3', back);
    assert.ok((await import('node:fs/promises')).readFile(back).then((b) => b.equals(big)));
  });

  test('wrong credentials give a helpful error', async () => {
    const bad = new S3Client({ endpoint: s3.endpoint, region: S3_CREDS.region, bucket: S3_CREDS.bucket, accessKeyId: S3_CREDS.accessKeyId, secretAccessKey: 'wrong', pathStyle: true });
    await assert.rejects(bad.putBuffer('k', Buffer.from('x'), 'text/plain'), /SignatureDoesNotMatch.*check the secret key and region/);
    const noBucket = new S3Client({ endpoint: s3.endpoint, region: S3_CREDS.region, bucket: 'nope', accessKeyId: S3_CREDS.accessKeyId, secretAccessKey: S3_CREDS.secret, pathStyle: true });
    await assert.rejects(noBucket.putBuffer('k', Buffer.from('x'), 'text/plain'), /NoSuchBucket.*check the bucket name/);
    const unreachable = new S3Client({ endpoint: 'http://127.0.0.1:1', region: 'r', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', pathStyle: true });
    await assert.rejects(unreachable.putBuffer('k', Buffer.from('x'), 'text/plain'), /Couldn't reach/);
  });

  test('public-read is sent when the provider needs it', async () => {
    const withAcl = new S3Client({ endpoint: s3.endpoint, region: S3_CREDS.region, bucket: S3_CREDS.bucket, accessKeyId: S3_CREDS.accessKeyId, secretAccessKey: S3_CREDS.secret, pathStyle: true, acl: 'public-read' });
    await withAcl.putBuffer('acl/x.txt', Buffer.from('x'), 'text/plain');
    assert.equal(s3.objects.get('acl/x.txt')!.acl, 'public-read');
  });
});

describe('Bunny client', () => {
  let bunny: FakeBunny;
  before(async () => {
    bunny = await startFakeBunny({ zone: 'pods', password: 'zonepw' });
  });
  after(() => bunny.close());

  test('upload with checksum, download, delete a folder', async () => {
    const c = new BunnyClient({ hostname: bunny.hostname, zone: 'pods', password: 'zonepw' });
    await c.putBuffer('show/media/audio/1.mp3', Buffer.from('one'), 'audio/mpeg');
    await c.putBuffer('show/media/images/a.jpg', Buffer.from('img'), 'image/jpeg');
    assert.equal((await c.getBuffer('show/media/audio/1.mp3')).toString(), 'one');
    await c.deletePrefix('show/');
    assert.equal(bunny.files.size, 0);
    await assert.rejects(c.deletePrefix(''), /whole storage zone/);
  });

  test('wrong password or zone explain themselves', async () => {
    await assert.rejects(
      new BunnyClient({ hostname: bunny.hostname, zone: 'pods', password: 'nope' }).putBuffer('k', Buffer.from('x'), 'text/plain'),
      /HTTP 401.*storage zone password/,
    );
    await assert.rejects(
      new BunnyClient({ hostname: bunny.hostname, zone: 'other', password: 'zonepw' }).putBuffer('k', Buffer.from('x'), 'text/plain'),
      /HTTP 404.*storage zone name/,
    );
  });
});

describe('connection test', () => {
  let s3: FakeS3;
  let bunny: FakeBunny;
  const config = testConfig();
  before(async () => {
    s3 = await startFakeS3(S3_CREDS);
    bunny = await startFakeBunny({ zone: 'pods', password: 'zonepw' });
  });
  after(async () => {
    await s3.close();
    await bunny.close();
  });
  const s3State = (over: Record<string, string> = {}, secret = S3_CREDS.secret) => ({
    provider: 'other',
    settings: { endpoint: s3.endpoint, region: S3_CREDS.region, accessKeyId: S3_CREDS.accessKeyId, bucket: S3_CREDS.bucket, pathStyle: true, publicUrl: s3.publicUrl, ...over },
    secret,
  });

  test('all four steps pass with good settings, and the test file is cleaned up', async () => {
    const r = await testConnection(config, s3State());
    assert.equal(r.ok, true, JSON.stringify(r.steps));
    assert.deepEqual(r.steps.map((s) => s.step), ['Upload a test file', 'Read it back', 'Download it from the public address', 'Delete the test file']);
    assert.ok(![...s3.objects.keys()].some((k) => k.startsWith('_podsovereign-test/')));
  });

  test('a wrong public address is caught (podcast apps couldn’t download)', async () => {
    const r = await testConnection(config, s3State({ publicUrl: `${s3.endpoint}/elsewhere` }));
    assert.equal(r.ok, false);
    const pub = r.steps.find((s) => s.step === 'Download it from the public address')!;
    assert.equal(pub.ok, false);
    assert.match(pub.detail, /Podcast apps need to reach files at the public address/);
    assert.ok(r.steps.find((s) => s.step === 'Delete the test file')!.ok, 'still cleans up');
  });

  test('a wrong key stops at the first step', async () => {
    const r = await testConnection(config, s3State({}, 'wrong'));
    assert.equal(r.ok, false);
    assert.equal(r.steps.length, 1);
    assert.match(r.steps[0]!.detail, /SignatureDoesNotMatch/);
  });

  test('Bunny works too', async () => {
    const r = await testConnection(config, { provider: 'bunny', settings: { zone: 'pods', hostname: bunny.hostname, publicUrl: bunny.publicUrl }, secret: 'zonepw' });
    assert.equal(r.ok, true, JSON.stringify(r.steps));
  });
});

describe('end to end: settings, imports to remote storage, moving media', () => {
  let db: Db;
  let config: Config;
  let server: http.Server;
  let base: string;
  let host: Awaited<ReturnType<typeof startOldHost>>;
  let s3: FakeS3;
  let bunny: FakeBunny;
  let mediaDir: string;
  let cookie = '';
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const s3Body = (over: Record<string, unknown> = {}) => ({
    provider: 'other',
    settings: { endpoint: s3.endpoint, region: S3_CREDS.region, accessKeyId: S3_CREDS.accessKeyId, bucket: S3_CREDS.bucket, pathStyle: true, publicUrl: s3.publicUrl },
    secret: S3_CREDS.secret,
    ...over,
  });
  const runImport = async (name: string, guidPrefix: string, slug: string) => {
    host.feeds.set(name, fixtureOn(host.base, (x) => x.replace('917393e3', guidPrefix)));
    const r = await api('POST', '/api/imports', { url: `${host.base}/feeds/${name}.xml`, slug });
    assert.equal(r.status, 202, r.text);
    await runImportJob({ db, config }, (await claimNextJob(db))!);
    return (await db.query<{ id: string }>(`SELECT id FROM podcasts WHERE slug = $1`, [slug])).rows[0]!.id;
  };

  before(async () => {
    db = await setupDb('feedhost_storage_test');
    host = await startOldHost();
    host.files.set('/old/ep2.chapters.json', {
      type: 'application/json',
      body: JSON.stringify({ version: '1.2.0', chapters: [{ startTime: 0, title: 'Intro', img: `${host.base}/old/intro.jpg` }] }),
    });
    s3 = await startFakeS3(S3_CREDS);
    bunny = await startFakeBunny({ zone: 'pods', password: 'zonepw' });
    mediaDir = await tempDir('storage-media');
    config = testConfig({ mediaDir, siteDir: await tempDir('storage-site') });
    server = http.createServer(createApp({ db, config }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await api('POST', '/api/auth/register', { email: 'admin@example.com', password: 'admin long password' });
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await host.close();
    await s3.close();
    await bunny.close();
    await db.close();
  });

  test('storage settings start on this server; the secret is never returned', async () => {
    const r = await api('GET', '/api/admin/storage');
    assert.equal(r.json.current.provider, 'local');
    assert.equal(r.json.providers.length, 7);
    const t = await api('POST', '/api/admin/storage/test', s3Body());
    assert.equal(t.json.ok, true, JSON.stringify(t.json));
  });

  test('a failing connection test blocks saving', async () => {
    const r = await api('PUT', '/api/admin/storage', s3Body({ secret: 'wrong' }));
    assert.equal(r.status, 400);
    assert.match(r.json.error, /connection test failed/);
    assert.equal(r.json.test.steps[0].ok, false);
    assert.equal(config.storage.provider, 'local');
  });

  let local: string;
  test('a show imported while storage is local lives on this server', async () => {
    local = await runImport('a', 'aaaaaaaa', 'local-show');
    assert.ok(existsSync(path.join(mediaDir, 'local-show', 'media', 'audio')));
    const feed = (await loadFeed(db, local))!;
    assert.ok(feed.items[0]!.enclosureUrl!.startsWith('https://feeds.mine.test/local-show/media/'));
  });

  test('switching to S3 with media present queues a background move; imports pause meanwhile', async () => {
    const r = await api('PUT', '/api/admin/storage', s3Body());
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.switched, false);
    assert.equal(r.json.move.status, 'queued');
    assert.equal(config.storage.provider, 'local', 'not switched until the files are moved');
    const blocked = await api('POST', '/api/imports', { url: `${host.base}/feeds/a.xml` });
    assert.equal(blocked.status, 400);
    assert.match(blocked.json.error, /being moved/);
    assert.equal((await api('PUT', '/api/admin/storage', s3Body())).status, 400, 'one move at a time');
  });

  test('the move copies every file, switches over, rewrites links and frees local space', async () => {
    const queued = (await db.query<{ to_state: { secret: string } }>(`SELECT to_state FROM storage_moves WHERE status = 'queued'`)).rows[0]!;
    assert.match(queued.to_state.secret, /^enc:v1:/, 'the queued move keeps the new key encrypted');
    const move = (await claimMove(db))!;
    await runMove({ db, config }, move);
    const st = (await api('GET', '/api/admin/storage')).json;
    assert.equal(st.move.status, 'done', st.move.error);
    assert.equal(st.move.failed, 0);
    assert.ok(st.move.moved > 5);
    assert.equal(st.current.provider, 'other');
    assert.equal(st.current.secretSet, true);
    assert.ok(!JSON.stringify(st).includes(S3_CREDS.secret), 'secret never sent back');
    const done = (await db.query<{ from_state: { secret: unknown }; to_state: { secret: unknown } }>(`SELECT from_state, to_state FROM storage_moves WHERE id = $1`, [move.id])).rows[0]!;
    assert.equal(done.to_state.secret, null, 'a finished move forgets the keys');
    assert.match((await db.query<{ s: string }>(`SELECT storage_secret AS s FROM site_settings WHERE id`)).rows[0]!.s, /^enc:v1:/);

    const { rows } = await db.query<{ storage_provider: string; storage_path: string | null; storage_key: string }>(
      `SELECT storage_provider, storage_path, storage_key FROM media_files WHERE status = 'done'`,
    );
    assert.ok(rows.every((r) => r.storage_provider === 'other' && r.storage_path === null && s3.objects.has(r.storage_key)));
    const left = (await readdir(path.join(mediaDir, 'local-show', 'media', 'audio')).catch(() => [])).length;
    assert.equal(left, 0, 'local copies removed');

    const feed = (await loadFeed(db, local))!;
    assert.ok(feed.items[0]!.enclosureUrl!.startsWith(`${s3.publicUrl}/local-show/media/audio/`));
    const xml = await (await fetch(`${base}/local-show/feed.xml`)).text();
    assert.ok(xml.includes(`url="${s3.publicUrl}/local-show/media/audio/`));

    const chapterKey = rows.find((r) => r.storage_key.includes('/chapters/'))!.storage_key;
    const chapters = JSON.parse(s3.objects.get(chapterKey)!.body.toString());
    assert.ok(chapters.chapters[0].img.startsWith(`${s3.publicUrl}/local-show/media/images/`), 'chapter file in the bucket rewritten');

    // The enclosure really downloads from the public address.
    const enc = await fetch(feed.items[0]!.enclosureUrl!);
    assert.equal(enc.status, 200);

    // Old links on this server (from feed copies apps cached before the move) redirect to the new home.
    const oldPath = new URL(feed.items[0]!.enclosureUrl!).pathname.replace(/^\/public/, '');
    const old = await fetch(base + oldPath, { redirect: 'manual' });
    assert.equal(old.status, 301);
    assert.equal(old.headers.get('location'), `${s3.publicUrl}${oldPath}`);
  });

  test('new imports go straight to the bucket; nothing is left on this server', async () => {
    const id = await runImport('b', 'bbbbbbbb', 'remote-show');
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM media_files WHERE podcast_id = $1 AND status = 'done' AND storage_provider = 'other'`,
      [id],
    );
    assert.ok(rows[0]!.n > 5);
    assert.equal(existsSync(path.join(mediaDir, 'remote-show', 'media', 'audio')) ? (await readdir(path.join(mediaDir, 'remote-show', 'media', 'audio'))).length : 0, 0);
    const chapterKey = [...s3.objects.keys()].find((k) => k.startsWith('remote-show/media/chapters/'))!;
    assert.ok(JSON.parse(s3.objects.get(chapterKey)!.body.toString()).chapters[0].img.startsWith(`${s3.publicUrl}/remote-show/`));
  });

  test('changing only the key or public address updates in place (no move)', async () => {
    const r = await api('PUT', '/api/admin/storage', s3Body({ secret: '' }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.switched, true, 'blank secret keeps the saved one');
  });

  test('moving between two providers (S3 → Bunny)', async () => {
    const r = await api('PUT', '/api/admin/storage', {
      provider: 'bunny',
      settings: { zone: 'pods', hostname: bunny.hostname, publicUrl: bunny.publicUrl },
      secret: 'zonepw',
    });
    assert.equal(r.status, 202, r.text);
    await runMove({ db, config }, (await claimMove(db))!);
    assert.equal(config.storage.provider, 'bunny');
    assert.ok(bunny.files.size > 10);
    const feed = (await loadFeed(db, local))!;
    assert.ok(feed.items[0]!.enclosureUrl!.startsWith(`${bunny.publicUrl}/local-show/media/audio/`));
  });

  test('if any file fails to move, nothing switches and the old storage keeps serving', async () => {
    // Move back to S3, with one upload failing.
    const victim = [...bunny.files.keys()].find((k) => k.includes('/audio/'))!;
    s3.failKeys.add(victim);
    const r = await api('PUT', '/api/admin/storage', s3Body({ settings: { ...s3Body().settings, bucket: S3_CREDS.bucket } }));
    assert.equal(r.status, 202, r.text);
    await runMove({ db, config }, (await claimMove(db))!);
    const st = (await api('GET', '/api/admin/storage')).json;
    assert.equal(st.move.status, 'failed');
    assert.match(st.move.error, /1 of \d+ files couldn't be moved, so storage was not switched/);
    assert.equal(config.storage.provider, 'bunny');
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM media_files WHERE status = 'done' AND storage_provider <> 'bunny'`);
    assert.equal(rows[0]!.n, 0, 'every file still points at Bunny');
    const feed = (await loadFeed(db, local))!;
    assert.ok(feed.items[0]!.enclosureUrl!.startsWith(bunny.publicUrl));
    s3.failKeys.clear();
  });

  test('deleting a show removes its files from the provider', async () => {
    const id = (await db.query<{ id: string }>(`SELECT id FROM podcasts WHERE slug = 'remote-show'`)).rows[0]!.id;
    assert.ok([...bunny.files.keys()].some((k) => k.startsWith('remote-show/')));
    assert.equal((await api('DELETE', `/api/podcasts/${id}`)).status, 204);
    assert.ok(![...bunny.files.keys()].some((k) => k.startsWith('remote-show/')));
    assert.ok([...bunny.files.keys()].some((k) => k.startsWith('local-show/')), 'other shows untouched');
  });

  test('back to this server: files come home and links point here again', async () => {
    const r = await api('PUT', '/api/admin/storage', { provider: 'local' });
    assert.equal(r.status, 202, r.text);
    await runMove({ db, config }, (await claimMove(db))!);
    assert.equal(config.storage.provider, 'local');
    const feed = (await loadFeed(db, local))!;
    assert.ok(feed.items[0]!.enclosureUrl!.startsWith('https://feeds.mine.test/local-show/media/audio/'));
    const res = await fetch(`${base}${new URL(feed.items[0]!.enclosureUrl!).pathname}`);
    assert.equal(res.status, 200, 'served by this server again');
  });
});
