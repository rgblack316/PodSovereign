import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import type { Config } from '../src/config.js';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { claimNextJob, runImportJob } from '../src/import/importer.js';
import { sendViaResend } from '../src/mail/resend.js';
import { fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './support/env.js';

interface Sent {
  auth: string;
  idempotencyKey: string;
  body: { from: string; to: string[]; subject: string; text: string };
}

/** TEST-ONLY Resend API: POST /emails, Bearer key, verified-domain check. */
async function startFakeResend(opts: { key: string; verifiedDomain: string }) {
  const sent: Sent[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const reply = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.method !== 'POST' || req.url !== '/emails') return reply(404, { statusCode: 404, name: 'not_found', message: 'Not found' });
      const auth = req.headers.authorization ?? '';
      if (!auth) return reply(401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key in the authorization header.' });
      if (auth !== `Bearer ${opts.key}`) return reply(400, { statusCode: 400, name: 'validation_error', message: 'API key is invalid' });
      const body = JSON.parse(raw);
      const domain = /@([^>\s]+)>?$/.exec(body.from)?.[1];
      if (domain !== opts.verifiedDomain) {
        return reply(403, { statusCode: 403, name: 'validation_error', message: `The ${domain} domain is not verified. Please, add and verify your domain on https://resend.com/domains` });
      }
      if (body.subject === 'flood') return reply(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests.' });
      sent.push({ auth, idempotencyKey: String(req.headers['idempotency-key'] ?? ''), body });
      reply(200, { id: `email-${sent.length}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('Resend client', () => {
  let fake: Awaited<ReturnType<typeof startFakeResend>>;
  before(async () => {
    fake = await startFakeResend({ key: 're_good_key_123', verifiedDomain: 'jcs.test' });
  });
  after(() => fake.close());

  test('sends JSON with a Bearer key and an idempotency key', async () => {
    const r = await sendViaResend({ apiKey: 're_good_key_123', from: 'Johns Creek Studios <podcasts@jcs.test>', apiUrl: fake.url }, { to: 'owner@example.com', subject: 'Hi', text: 'Body' });
    assert.equal(r.id, 'email-1');
    const s = fake.sent[0]!;
    assert.equal(s.auth, 'Bearer re_good_key_123');
    assert.match(s.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual(s.body, { from: 'Johns Creek Studios <podcasts@jcs.test>', to: ['owner@example.com'], subject: 'Hi', text: 'Body' });
  });

  test('explains common failures', async () => {
    const send = (apiKey: string, from: string, subject = 'x') => sendViaResend({ apiKey, from, apiUrl: fake.url }, { to: 'a@b.test', subject, text: 't' });
    await assert.rejects(send('re_wrong', 'a@jcs.test'), /API key is invalid.*Check the API key/);
    await assert.rejects(send('re_good_key_123', 'a@other.test'), /other\.test domain is not verified.*Verify other\.test at resend\.com\/domains/);
    await assert.rejects(send('re_good_key_123', 'a@jcs.test', 'flood'), /Too many emails at once/);
    await assert.rejects(sendViaResend({ apiKey: 'k', from: 'a@jcs.test', apiUrl: 'http://127.0.0.1:1' }, { to: 'a@b.test', subject: 'x', text: 't' }), /Couldn't reach Resend/);
  });
});

describe('Resend in Site settings and verification', () => {
  let db: Db;
  let config: Config;
  let server: http.Server;
  let base: string;
  let host: Awaited<ReturnType<typeof startOldHost>>;
  let fake: Awaited<ReturnType<typeof startFakeResend>>;
  let cookie = '';
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const t = await res.text();
    return { status: res.status, json: t ? JSON.parse(t) : null };
  };

  before(async () => {
    db = await setupDb('feedhost_resend_test');
    host = await startOldHost();
    fake = await startFakeResend({ key: 're_live_abcdef123456', verifiedDomain: 'johnscreekstudios.com' });
    config = testConfig({ mediaDir: await tempDir('resend-media'), siteDir: await tempDir('resend-site'), resendApiUrl: fake.url });
    server = http.createServer(createApp({ db, config }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await api('POST', '/api/auth/register', { email: 'randy@johnscreekstudios.com', password: 'admin long password' });
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await host.close();
    await fake.close();
    await db.close();
  });

  test('saving Resend settings: key format checked, key never returned', async () => {
    assert.equal((await api('PUT', '/api/admin/site', { resend: { from: 'podcasts@johnscreekstudios.com' } })).status, 400, 'key required the first time');
    assert.equal((await api('PUT', '/api/admin/site', { resend: { apiKey: 'sk_nope', from: 'podcasts@johnscreekstudios.com' } })).status, 400);
    assert.equal((await api('PUT', '/api/admin/site', { resend: { apiKey: 're_live_abcdef123456', from: 'not-an-email' } })).status, 400);
    const r = await api('PUT', '/api/admin/site', { resend: { apiKey: 're_live_abcdef123456', from: 'Johns Creek Studios <podcasts@johnscreekstudios.com>' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.settings.mail, { configured: true, provider: 'resend', from: 'Johns Creek Studios <podcasts@johnscreekstudios.com>', resendKeySet: true });
    assert.ok(!JSON.stringify(r.json).includes('re_live_abcdef123456'));
    // Changing just the From keeps the saved key.
    const again = await api('PUT', '/api/admin/site', { resend: { from: 'JCS <hello@johnscreekstudios.com>' } });
    assert.equal(again.json.settings.mail.resendKeySet, true);
  });

  test('the test email goes through Resend; a bad sending domain is explained', async () => {
    const ok = await api('POST', '/api/admin/site/test-email', {});
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(fake.sent.at(-1)!.body.to, ['randy@johnscreekstudios.com']);
    await api('PUT', '/api/admin/site', { resend: { from: 'podcasts@unverified.test' } });
    const bad = await api('POST', '/api/admin/site/test-email', {});
    assert.equal(bad.status, 502);
    assert.match(bad.json.error, /Verify unverified\.test at resend\.com\/domains/);
    await api('PUT', '/api/admin/site', { resend: { from: 'Johns Creek Studios <podcasts@johnscreekstudios.com>' } });
  });

  test('verification codes are delivered via Resend', async () => {
    await api('PUT', '/api/admin/site', { requireVerification: true });
    host.feeds.set('show', fixtureOn(host.base));
    const start = await api('POST', '/api/imports', { url: `${host.base}/feeds/show.xml` });
    await runImportJob({ db, config }, (await claimNextJob(db))!);
    const id = start.json.job.id;
    assert.equal((await api('GET', `/api/imports/${id}`)).json.job.verification.canEmail, true);
    const sent = await api('POST', `/api/imports/${id}/send-code`);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    const mail = fake.sent.at(-1)!.body;
    assert.deepEqual(mail.to, ['owner@example.com']);
    const code = /\b(\d{6})\b/.exec(mail.subject)![1];
    assert.equal((await api('POST', `/api/imports/${id}/verify-code`, { code })).status, 200);
    await runImportJob({ db, config }, (await claimNextJob(db))!);
    assert.equal((await api('GET', `/api/imports/${id}`)).json.job.status, 'done');
  });

  test('a Resend failure when sending a code is explained to the podcaster', async () => {
    await api('PUT', '/api/admin/site', { resend: { from: 'podcasts@unverified.test' } });
    host.feeds.set('show2', fixtureOn(host.base, (x) => x.replace('917393e3', 'a9a9a9a9')));
    const start = await api('POST', '/api/imports', { url: `${host.base}/feeds/show2.xml` });
    await runImportJob({ db, config }, (await claimNextJob(db))!);
    const r = await api('POST', `/api/imports/${start.json.job.id}/send-code`);
    assert.equal(r.status, 502);
    assert.match(r.json.error, /The code couldn’t be sent: .*Use the feed tag instead/);
  });

  test('switching back to SMTP', async () => {
    const r = await api('PUT', '/api/admin/site', { smtp: { host: 'smtp.example.com', security: 'starttls', from: 'podcasts@johnscreekstudios.com' } });
    assert.equal(r.json.settings.mail.provider, 'smtp');
    assert.equal(config.mail?.provider, 'smtp');
  });
});
