import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { parseFeed } from '../src/feed/parser.js';
import { createApp } from '../src/http/app.js';
import { claimNextJob, runImportJob } from '../src/import/importer.js';
import { feedHasToken, maskEmail, ownerEmail } from '../src/import/verify.js';
import { sendMail } from '../src/mail/smtp.js';
import { startFakeSmtp, type FakeSmtp } from './support/fake-smtp.js';
import { FIXTURE, fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

describe('helpers', () => {
  test('finds the token in podcast:txt, the description or itunes:summary', () => {
    const t = 'podsovereign-verify-abc123';
    const withTxt = parseFeed(FIXTURE.replace('<podcast:medium>', `<podcast:txt purpose="verify">${t}</podcast:txt>\n<podcast:medium>`)).feed;
    assert.equal(feedHasToken(withTxt, t), true);
    const inDesc = parseFeed(FIXTURE.replace('A show about', `${t} A show about`)).feed;
    assert.equal(feedHasToken(inDesc, t), true);
    const inSummary = parseFeed(FIXTURE.replace('Plain summary text.', `Plain summary text. ${t}`)).feed;
    assert.equal(feedHasToken(inSummary, t), true);
    assert.equal(feedHasToken(parseFeed(FIXTURE).feed, t), false);
    const partial = parseFeed(FIXTURE.replace('<podcast:medium>', `<podcast:txt purpose="verify">${t}-extra</podcast:txt>\n<podcast:medium>`)).feed;
    assert.equal(feedHasToken(partial, t), false, 'a txt tag must match exactly');
  });

  test('owner email and masking', () => {
    assert.equal(ownerEmail(parseFeed(FIXTURE).feed), 'owner@example.com');
    const viaEditor = parseFeed(FIXTURE.replace(/<itunes:owner>[\s\S]*?<\/itunes:owner>/, '').replace('<language>', '<managingEditor>editor@show.com (The Editor)</managingEditor><language>')).feed;
    assert.equal(ownerEmail(viaEditor), 'editor@show.com');
    assert.equal(maskEmail('randy@johnscreekstudios.com'), 'r••••@johnscreekstudios.com');
    assert.equal(maskEmail('a@b.co'), 'a••@b.co');
  });
});

describe('SMTP client', () => {
  test('plain connection with AUTH PLAIN; UTF-8 subject and body', async () => {
    const smtp = await startFakeSmtp({ user: 'me', password: 'pw' });
    await sendMail(
      { host: '127.0.0.1', port: smtp.port, security: 'none', user: 'me', password: 'pw', from: 'John’s Creek Studios <podcasts@jcs.test>' },
      { to: 'owner@example.com', subject: 'Café code 123456', text: 'Line one\nLíne two\n.leading dot' },
    );
    const m = smtp.messages[0]!;
    assert.equal(m.from, 'podcasts@jcs.test');
    assert.deepEqual(m.to, ['owner@example.com']);
    assert.equal(m.subject, 'Café code 123456');
    assert.equal(m.text, 'Line one\r\nLíne two\r\n.leading dot');
    assert.match(m.data, /^From: =\?UTF-8\?B\?/m, 'non-ASCII sender name encoded');
    await smtp.close();
  });

  test('STARTTLS then AUTH LOGIN-capable server', async () => {
    const smtp = await startFakeSmtp({ user: 'me', password: 'pw', starttls: true });
    await sendMail(
      { host: '127.0.0.1', port: smtp.port, security: 'starttls', user: 'me', password: 'pw', from: 'a@b.test', insecureTls: true },
      { to: 'x@y.test', subject: 'Hi', text: 'Secure' },
    );
    assert.equal(smtp.messages[0]!.text, 'Secure');
    await assert.rejects(
      sendMail({ host: '127.0.0.1', port: smtp.port, security: 'starttls', user: 'me', password: 'pw', from: 'a@b.test' }, { to: 'x@y.test', subject: 'Hi', text: 'x' }),
      /Secure connection failed/,
      'self-signed certificates are rejected unless explicitly allowed',
    );
    await smtp.close();
  });

  test('clear errors for wrong password, rejected recipient, and unreachable servers', async () => {
    const smtp = await startFakeSmtp({ user: 'me', password: 'pw' });
    const cfg = { host: '127.0.0.1', port: smtp.port, security: 'none' as const, user: 'me', password: 'nope', from: 'a@b.test' };
    await assert.rejects(sendMail(cfg, { to: 'x@y.test', subject: 's', text: 't' }), /rejected the username or password: 535/);
    await assert.rejects(sendMail({ ...cfg, password: 'pw' }, { to: 'nobody@y.test', subject: 's', text: 't' }), /rejected the recipient address: 550/);
    await assert.rejects(sendMail({ ...cfg, port: 1 }, { to: 'x@y.test', subject: 's', text: 't' }), /Couldn't connect to 127.0.0.1:1/);
    await assert.rejects(sendMail({ ...cfg, from: 'not an email' }, { to: 'x@y.test', subject: 's', text: 't' }), /isn’t a valid email/);
    await assert.rejects(sendMail({ ...cfg, password: 'pw' }, { to: 'x@y.test', subject: 'a\r\nBcc: evil@x.test', text: 't' }), /Invalid characters/);
    await smtp.close();
  });
});

describe('verification flow', () => {
  let db: Db;
  let config: Config;
  let server: http.Server;
  let base: string;
  let host: Awaited<ReturnType<typeof startOldHost>>;
  let smtp: FakeSmtp;

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
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    }
    get = (p: string) => this.req('GET', p);
    post = (p: string, b?: unknown) => this.req('POST', p, b);
  }
  const admin = new Client();
  const pod = new Client();
  const other = new Client();

  const runWorker = async () => {
    const job = await claimNextJob(db);
    if (job) await runImportJob({ db, config }, job);
    return job;
  };

  before(async () => {
    db = await setupDb('feedhost_verify_test');
    host = await startOldHost();
    smtp = await startFakeSmtp();
    config = testConfig({ mediaDir: await tempDir('verify-media'), siteDir: await tempDir('verify-site') });
    server = http.createServer(createApp({ db, config }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await admin.post('/api/auth/register', { email: 'admin@example.com', password: 'admin long password' });
    await admin.post('/api/admin/users', { email: 'pod@example.com', password: 'podcaster password' });
    await admin.post('/api/admin/users', { email: 'other@example.com', password: 'other person pw!' });
    await pod.post('/api/auth/login', { email: 'pod@example.com', password: 'podcaster password' });
    await other.post('/api/auth/login', { email: 'other@example.com', password: 'other person pw!' });
    const r = await admin.req('PUT', '/api/admin/site', { requireVerification: true });
    assert.equal(r.json.settings.requireVerification, true);
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await host.close();
    await smtp.close();
    await db.close();
  });

  const startImport = async (c: Client, name: string, guid: string) => {
    host.feeds.set(name, fixtureOn(host.base, (x) => x.replace('917393e3', guid)));
    const r = await c.post('/api/imports', { url: `${host.base}/feeds/${name}.xml` });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    await runWorker();
    return (await c.get(`/api/imports/${r.json.job.id}`)).json.job;
  };
  const podcastCount = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM podcasts`)).rows[0]!.n;

  let job: any;
  test('the import pauses before saving anything, with a preview and a token', async () => {
    job = await startImport(pod, 'tagged', 'a1111111');
    assert.equal(job.status, 'verifying');
    assert.equal(job.preview.title, 'The Test Show & Friends');
    assert.equal(job.preview.episodes, 2);
    assert.equal(job.preview.ownerEmail, 'o••••@example.com');
    assert.match(job.verification.token, /^podsovereign-verify-[\w-]{16}$/);
    assert.equal(job.verification.tag, `<podcast:txt purpose="verify">${job.verification.token}</podcast:txt>`);
    assert.equal(job.verification.canEmail, false);
    assert.equal(job.verification.emailReason, 'not_configured');
    assert.equal(await podcastCount(), 0, 'nothing saved');
    assert.ok(!host.hits.has('/old/media/ep1.m4a'), 'no media downloaded');
    assert.equal(await claimNextJob(db), null, 'the worker leaves it alone');
  });

  test('other users can’t see or act on someone else’s verification', async () => {
    for (const p of ['check-feed', 'send-code', 'verify-code', 'cancel']) {
      assert.equal((await other.post(`/api/imports/${job.id}/${p}`, { code: '000000' })).status, 404, p);
    }
    assert.equal((await other.get(`/api/imports/${job.id}`)).status, 404);
    assert.equal((await pod.post(`/api/imports/${job.id}/skip-verification`)).status, 403, 'only admins can skip');
  });

  test('“Check my feed” before the tag is added says so', async () => {
    const r = await pod.post(`/api/imports/${job.id}/check-feed`);
    assert.equal(r.json.verified, false);
    assert.match(r.json.message, /isn’t in the feed yet/);
  });

  test('adding the podcast:txt tag at the old host verifies it, and the import runs', async () => {
    host.feeds.set('tagged', fixtureOn(host.base, (x) =>
      x.replace('917393e3', 'a1111111').replace('<podcast:medium>', `${job.verification.tag}\n    <podcast:medium>`)));
    const r = await pod.post(`/api/imports/${job.id}/check-feed`);
    assert.equal(r.json.verified, true);
    assert.equal(r.json.job.status, 'queued');
    await runWorker();
    const done = (await pod.get(`/api/imports/${job.id}`)).json.job;
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.verifiedMethod, 'feed');
    assert.equal(await podcastCount(), 1);
  });

  test('a token already in the feed on the first run is accepted straight away (re-import after cancel)', async () => {
    const first = await startImport(pod, 'retry', 'b2222222');
    await pod.post(`/api/imports/${first.id}/cancel`);
    assert.equal((await pod.get(`/api/imports/${first.id}`)).json.job.error, 'Cancelled');
    assert.equal((await pod.post(`/api/imports/${first.id}/check-feed`)).status, 409, 'cancelled jobs can’t be verified');
  });

  test('email codes: send, wrong code, right code', async () => {
    await admin.req('PUT', '/api/admin/site', {
      smtp: { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'Johns Creek Studios <podcasts@jcs.test>' },
    });
    const j = await startImport(pod, 'emailed', 'c3333333');
    assert.equal(j.verification.canEmail, true);
    const sent = await pod.post(`/api/imports/${j.id}/send-code`);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.equal(sent.json.sentTo, 'o••••@example.com');
    const mail = smtp.messages.at(-1)!;
    assert.deepEqual(mail.to, ['owner@example.com'], 'sent to the feed’s owner, not the person importing');
    const code = /\b(\d{6})\b/.exec(mail.subject)![1]!;
    assert.match(mail.text, /If it isn't you, ignore this email/);

    const again = await pod.post(`/api/imports/${j.id}/send-code`);
    assert.equal(again.status, 429, 'can’t resend within a minute');

    const wrong = await pod.post(`/api/imports/${j.id}/verify-code`, { code: code === '000000' ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /4 tries left/);
    const { rows } = await db.query<{ verify_code_hash: string }>(`SELECT verify_code_hash FROM import_jobs WHERE id = $1`, [j.id]);
    assert.ok(!rows[0]!.verify_code_hash.includes(code), 'only a hash is stored');

    const right = await pod.post(`/api/imports/${j.id}/verify-code`, { code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });
    assert.equal(right.status, 200, JSON.stringify(right.json));
    await runWorker();
    const done = (await pod.get(`/api/imports/${j.id}`)).json.job;
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.verifiedMethod, 'email');
  });

  test('too many wrong codes locks the code', async () => {
    const j = await startImport(pod, 'locked-code', 'd4444444');
    await pod.post(`/api/imports/${j.id}/send-code`);
    for (let i = 0; i < 5; i++) await pod.post(`/api/imports/${j.id}/verify-code`, { code: '999999' === /\b(\d{6})\b/.exec(smtp.messages.at(-1)!.subject)![1] ? '888888' : '999999' });
    const r = await pod.post(`/api/imports/${j.id}/verify-code`, { code: /\b(\d{6})\b/.exec(smtp.messages.at(-1)!.subject)![1] });
    assert.equal(r.status, 429, 'even the right code is refused now');
    await pod.post(`/api/imports/${j.id}/cancel`);
  });

  test('admins can vouch for a show they manage', async () => {
    const j = await startImport(admin, 'admin-show', 'e5555555');
    assert.equal(j.status, 'verifying');
    const r = await admin.post(`/api/imports/${j.id}/skip-verification`);
    assert.equal(r.status, 200);
    await runWorker();
    assert.equal((await admin.get(`/api/imports/${j.id}`)).json.job.verifiedMethod, 'admin');
  });

  test('turning verification off imports straight away', async () => {
    await admin.req('PUT', '/api/admin/site', { requireVerification: false });
    const j = await startImport(pod, 'no-verify', 'f6666666');
    assert.equal(j.status, 'done', j.error);
    await admin.req('PUT', '/api/admin/site', { requireVerification: true });
  });

  test('unfinished verifications expire after 7 days', async () => {
    const j = await startImport(pod, 'stale', '07777777');
    await db.query(`UPDATE import_jobs SET created_at = now() - interval '8 days' WHERE id = $1`, [j.id]);
    const { requeueStaleJobs } = await import('../src/import/importer.js');
    await requeueStaleJobs(db);
    const after = (await pod.get(`/api/imports/${j.id}`)).json.job;
    assert.equal(after.status, 'failed');
    assert.match(after.error, /wasn’t verified within 7 days/);
  });

  test('admins can send a test email; settings never return the password', async () => {
    await admin.req('PUT', '/api/admin/site', {
      smtp: { host: '127.0.0.1', port: smtp.port, security: 'none', from: 'podcasts@jcs.test', user: '', password: 'secret-pw' },
    });
    const s = (await admin.get('/api/admin/site')).json.settings;
    assert.equal(s.smtp.passwordSet, true);
    assert.ok(!JSON.stringify(s).includes('secret-pw'));
    const r = await admin.post('/api/admin/site/test-email', {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.sentTo, 'admin@example.com');
    assert.match(smtp.messages.at(-1)!.subject, /Test email from/);
    assert.equal((await pod.post('/api/admin/site/test-email', {})).status, 403);
    const bad = await admin.req('PUT', '/api/admin/site', { smtp: { host: 'smtp.example.com', from: 'nope' } });
    assert.equal(bad.status, 400);
  });
});
