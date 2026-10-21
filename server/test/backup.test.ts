import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { nextRun, r2Override, runBackup, runDueBackup } from '../src/backup/backups.js';
import { dumpBuffer, encryptOpenSsl, encryptStream } from '../src/backup/dump.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { sendViaResend } from '../src/mail/resend.js';
import { startFakeSmtp, type FakeSmtp } from './support/fake-smtp.js';
import { startFakeS3, type FakeS3 } from './support/fake-storage.js';
import { freshDatabase, TEST_SOCKET } from './support/pgwire.js';
import { setupDb, tempDir, testConfig } from './support/env.js';

const DB_NAME = 'podsovereign_backup_test';
const socketDir = path.dirname(TEST_SOCKET);
const urlFor = (name: string) => `postgresql://postgres@/${name}?host=${encodeURIComponent(socketDir)}`;

let db: Db;
let server: http.Server;
let base: string;
let dir: string;
let smtp: FakeSmtp;
let s3: FakeS3;
let config: ReturnType<typeof testConfig>;

class Client {
  cookie = '';
  async req(method: string, p: string, body?: unknown) {
    const res = await fetch(base + p, {
      method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(buf.toString('utf8'));
    } catch {
      /* binary */
    }
    return { status: res.status, json, buf, headers: res.headers, text: buf.toString('utf8') };
  }
  get = (p: string) => this.req('GET', p);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  post = (p: string, b?: unknown) => this.req('POST', p, b);
}

const admin = new Client();
const member = new Client();

before(async () => {
  db = await setupDb(DB_NAME);
  dir = await tempDir('backup');
  smtp = await startFakeSmtp();
  s3 = await startFakeS3({ bucket: 'ps-backups', accessKeyId: 'AKBACKUP', secret: 'backup-secret', region: 'auto' });
  r2Override.endpoint = s3.endpoint;
  config = testConfig({ mediaDir: dir, databaseUrl: urlFor(DB_NAME), publicBaseUrl: 'http://feeds.mine.test', siteName: 'Johns Creek Studios' });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await admin.post('/api/auth/register', { email: 'randy@example.com', password: 'correct horse battery' })).status, 201);
  assert.equal((await admin.post('/api/admin/users', { email: 'sam@example.com', password: 'correct horse battery' })).status, 201);
  assert.equal((await member.post('/api/auth/login', { email: 'sam@example.com', password: 'correct horse battery' })).status, 200);
  await admin.post('/api/podcasts', { title: 'Garden Talk', slug: 'garden-talk' });
});

after(async () => {
  r2Override.endpoint = null;
  await new Promise<void>((r) => server.close(() => r()));
  await smtp.close();
  await s3.close();
  await db.close();
});

const sql = (gz: Buffer) => gunzipSync(gz).toString('utf8');
const decrypt = (enc: Buffer, pass: string) => {
  const inFile = path.join(dir, `in-${Date.now()}.enc`);
  const outFile = path.join(dir, `out-${Date.now()}.gz`);
  writeFileSync(inFile, enc);
  execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-md', 'sha256', '-in', inFile, '-out', outFile, '-pass', `pass:${pass}`]);
  return readFileSync(outFile);
};

describe('the dump', () => {
  test('is a gzipped SQL dump that restores into an empty database', async () => {
    const gz = await dumpBuffer(config.databaseUrl);
    const text = sql(gz);
    assert.match(text, /CREATE TABLE "public"\."podcasts"/);
    assert.match(text, /garden-talk/);
    const restored = await freshDatabase('podsovereign_restore_test');
    await restored.close();
    const r = spawnSync('psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', urlFor('podsovereign_restore_test')], { input: text, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const check = spawnSync('psql', ['-tA', '-d', urlFor('podsovereign_restore_test'), '-c', 'SELECT slug FROM podcasts'], { encoding: 'utf8' });
    assert.equal(check.stdout.trim(), 'garden-talk');
  });

  test('a bad connection is a clear error, not an empty backup', async () => {
    await assert.rejects(dumpBuffer(urlFor('no_such_database_here')), /pg_dump failed: .*no_such_database_here/);
  });

  test('encryption is OpenSSL-compatible, as a buffer and as a stream', async () => {
    const data = Buffer.from('hello backup '.repeat(1000));
    assert.ok(decrypt(encryptOpenSsl(data, 'a long passphrase'), 'a long passphrase').equals(data));
    const chunks: Buffer[] = [];
    for await (const c of Readable.from([data.subarray(0, 100), data.subarray(100)]).pipe(encryptStream('another passphrase'))) chunks.push(c as Buffer);
    assert.ok(decrypt(Buffer.concat(chunks), 'another passphrase').equals(data));
  });
});

describe('schedule', () => {
  test('daily and weekly times in the admin’s time zone, across a daylight-saving change', () => {
    const ny = { frequency: 'daily', hour: 3, weekday: 0, timezone: 'America/New_York' };
    assert.equal(nextRun(ny, new Date('2026-10-21T12:00:00Z'))!.toISOString(), '2026-10-22T07:00:00.000Z'); // 3am EDT
    assert.equal(nextRun(ny, new Date('2026-10-31T12:00:00Z'))!.toISOString(), '2026-11-01T08:00:00.000Z'); // 3am EST
    assert.equal(nextRun({ ...ny, frequency: 'weekly', weekday: 1, hour: 9 }, new Date('2026-10-21T12:00:00Z'))!.toISOString(), '2026-10-26T13:00:00.000Z');
    assert.equal(nextRun({ ...ny, frequency: 'off' }), null);
    assert.equal(nextRun({ ...ny, timezone: 'UTC' }, new Date('2026-10-21T02:59:30Z'))!.toISOString(), '2026-10-21T03:00:00.000Z');
  });
});

describe('admin panel', () => {
  test('only admins can see or use backups', async () => {
    for (const [m, p] of [['GET', '/api/admin/backups'], ['GET', '/api/admin/backups/download'], ['PUT', '/api/admin/backups'], ['POST', '/api/admin/backups/run']] as const) {
      assert.equal((await member.req(m, p, {})).status, 403, `${m} ${p}`);
    }
    const r = await admin.get('/api/admin/backups');
    assert.equal(r.status, 200);
    assert.match(r.json.pgDump, /pg_dump \(PostgreSQL\) 1\d/);
    assert.equal(r.json.schedule.frequency, 'off');
  });

  test('download: a fresh backup straight to the browser, recorded in the history', async () => {
    const r = await admin.get('/api/admin/backups/download');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/gzip');
    assert.match(r.headers.get('content-disposition')!, /^attachment; filename="podsovereign-db-\d{4}-\d\d-\d\d-\d{6}\.sql\.gz"$/);
    assert.match(sql(r.buf), /CREATE TABLE "public"\."users"/);
    const runs = (await admin.get('/api/admin/backups')).json.runs;
    assert.equal(runs[0].trigger, 'download');
    assert.equal(runs[0].status, 'done');
    assert.equal(runs[0].bytes, r.buf.length);
    assert.equal((await admin.get('/api/admin/backups/download?encrypt=1')).status, 400, 'no passphrase yet');
  });

  test('settings are checked; automatic backups need somewhere to go', async () => {
    let r = await admin.put('/api/admin/backups', { frequency: 'daily', hour: 3, timezone: 'America/New_York' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /email, an R2 bucket, or both/);
    assert.equal((await admin.put('/api/admin/backups', { timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await admin.put('/api/admin/backups', { hour: 24 })).status, 400);
    assert.equal((await admin.put('/api/admin/backups', { passphrase: 'short' })).status, 400);
    assert.equal((await admin.put('/api/admin/backups', { emailTo: 'not an email' })).status, 400);
    assert.equal((await admin.put('/api/admin/backups', { r2: { accountId: 'nope', bucket: 'x' } })).status, 400);
    r = await admin.put('/api/admin/backups', { frequency: 'daily', hour: 3, timezone: 'America/New_York', email: true });
    assert.equal(r.status, 200, r.text);
    assert.ok(Date.parse(r.json.schedule.nextAt) > Date.now());
    assert.deepEqual(r.json.email.admins, ['randy@example.com']);
  });

  test('email: the backup arrives as an attachment; without email set up, the run says so', async () => {
    let r = await admin.post('/api/admin/backups/run');
    assert.equal(r.json.run.status, 'failed');
    assert.match(r.json.run.error, /Email isn’t set up/);

    config.mail = { provider: 'smtp', smtp: { host: '127.0.0.1', port: smtp.port, security: 'none', user: null, password: null, from: 'PodSovereign <backups@mine.test>' } };
    r = await admin.post('/api/admin/backups/run');
    assert.equal(r.json.run.status, 'done', JSON.stringify(r.json.run));
    const msg = smtp.messages.at(-1)!;
    assert.deepEqual(msg.to, ['randy@example.com']);
    assert.match(msg.subject, /^Johns Creek Studios backup \d{4}-\d\d-\d\d$/);
    assert.match(msg.data, /Content-Type: multipart\/mixed/);
    const m = /filename="(podsovereign-db-[^"]+\.sql\.gz)"\r\n\r\n([\s\S]+?)\r\n--/.exec(msg.data)!;
    assert.ok(m, 'attachment present');
    assert.match(sql(Buffer.from(m[2]!.replace(/\r\n/g, ''), 'base64')), /CREATE TABLE "public"\."podcasts"/);
    const body = /charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]+?)\r\n--/.exec(msg.data)!;
    assert.match(Buffer.from(body[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'), /isn’t encrypted/);
  });

  test('with a passphrase, emailed backups are encrypted and OpenSSL decrypts them', async () => {
    assert.equal((await admin.put('/api/admin/backups', { passphrase: 'correct horse battery staple', emailTo: 'offsite@example.com' })).status, 200);
    const v = (await admin.get('/api/admin/backups')).json;
    assert.equal(v.passphraseSet, true);
    assert.ok(!JSON.stringify(v).includes('correct horse battery staple'), 'the passphrase is never sent back');
    const r = await admin.post('/api/admin/backups/run');
    assert.equal(r.json.run.status, 'done', JSON.stringify(r.json.run));
    assert.equal(r.json.run.encrypted, true);
    const msg = smtp.messages.at(-1)!;
    assert.deepEqual(msg.to, ['offsite@example.com']);
    const m = /filename="(podsovereign-db-[^"]+\.sql\.gz\.enc)"\r\n\r\n([\s\S]+?)\r\n--/.exec(msg.data)!;
    const enc = Buffer.from(m[2]!.replace(/\r\n/g, ''), 'base64');
    assert.equal(enc.subarray(0, 8).toString('latin1'), 'Salted__');
    assert.match(sql(decrypt(enc, 'correct horse battery staple')), /CREATE TABLE/);
    // An encrypted download works too.
    const d = await admin.get('/api/admin/backups/download?encrypt=1');
    assert.equal(d.status, 200);
    assert.match(sql(decrypt(d.buf, 'correct horse battery staple')), /CREATE TABLE/);
    assert.equal((await admin.put('/api/admin/backups', { passphrase: '' })).status, 200);
  });

  test('R2: test the bucket, upload, and keep only the newest backups', async () => {
    let r = await admin.put('/api/admin/backups', { r2: { accountId: '0123456789abcdef0123456789abcdef', accessKeyId: 'AKBACKUP', secret: 'backup-secret', bucket: 'ps-backups', prefix: 'nightly' }, keep: 2, email: false });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.r2.ready, true);
    assert.ok(!JSON.stringify(r.json).includes('backup-secret'));
    const t = await admin.post('/api/admin/backups/test-bucket');
    assert.equal(t.json.ok, true, JSON.stringify(t.json));
    assert.equal([...s3.objects.keys()].filter((k) => k.includes('_connection-test')).length, 0, 'test file cleaned up');

    for (const day of ['2026-10-18', '2026-10-19', '2026-10-20']) {
      const run = await runBackup(db, config, 'manual', null, new Date(`${day}T07:00:00Z`));
      assert.equal(run.status, 'done', JSON.stringify(run));
    }
    const keys = [...s3.objects.keys()].filter((k) => k.startsWith('nightly/')).sort();
    assert.deepEqual(keys, ['nightly/podsovereign-db-2026-10-19-070000.sql.gz', 'nightly/podsovereign-db-2026-10-20-070000.sql.gz']);
    assert.match(sql(s3.objects.get(keys[1]!)!.body), /CREATE TABLE/);

    r = await admin.put('/api/admin/backups', { r2: { accountId: '0123456789abcdef0123456789abcdef', accessKeyId: 'AKBACKUP', secret: 'wrong-secret', bucket: 'ps-backups' } });
    const bad = await admin.post('/api/admin/backups/test-bucket');
    assert.equal(bad.json.ok, false);
    await admin.put('/api/admin/backups', { r2: { accountId: '0123456789abcdef0123456789abcdef', accessKeyId: 'AKBACKUP', secret: 'backup-secret', bucket: 'ps-backups', prefix: 'nightly' } });
  });

  test('the scheduled backup runs once when due, then moves to the next time', async () => {
    await admin.put('/api/admin/backups', { frequency: 'daily', hour: 3, timezone: 'UTC' });
    await db.query(`UPDATE site_settings SET backup_next_at = '2026-10-22T03:00:00Z'`);
    assert.equal(await runDueBackup(db, config, new Date('2026-10-22T02:59:00Z')), false, 'not yet');
    assert.equal(await runDueBackup(db, config, new Date('2026-10-22T03:00:30Z')), true);
    assert.equal(await runDueBackup(db, config, new Date('2026-10-22T03:01:00Z')), false, 'only once');
    const v = (await admin.get('/api/admin/backups')).json;
    assert.equal(v.schedule.nextAt, '2026-10-23T03:00:00.000Z');
    assert.equal(v.runs[0].trigger, 'scheduled');
    assert.ok([...s3.objects.keys()].includes('nightly/podsovereign-db-2026-10-22-030030.sql.gz'));
  });
});

test('Resend sends attachments base64-encoded', async () => {
  let got: any = null;
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"email_1"}');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  try {
    await sendViaResend({ apiKey: 're_x', from: 'a@b.co', apiUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` },
      { to: 'c@d.co', subject: 's', text: 't', attachments: [{ filename: 'b.sql.gz', contentType: 'application/gzip', content: Buffer.from('xyz') }] });
    assert.deepEqual(got.attachments, [{ filename: 'b.sql.gz', content: Buffer.from('xyz').toString('base64') }]);
  } finally {
    fake.close();
  }
});
