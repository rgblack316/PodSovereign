import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { saveBackupSettings } from '../src/backup/backups.js';
import { encryptStoredSecrets, isSealed, loadSecretKey, seal, setSecretKey, unseal } from '../src/crypto/secrets.js';
import type { Db } from '../src/db/db.js';
import { loadSiteSettings, saveSiteSettings } from '../src/site/settings.js';
import { changeStorage } from '../src/storage/move.js';
import { setupDb, tempDir, testConfig } from './support/env.js';

const TEST_KEY = 'test-secret-key-0123456789abcdef0123456789abcdef';
let db: Db;
let dir: string;

before(async () => {
  db = await setupDb('podsovereign_secrets_test');
  dir = await tempDir('secrets');
});
after(async () => {
  setSecretKey(TEST_KEY);
  await db.close();
});

const site = async () => (await db.query<Record<string, any>>(`SELECT * FROM site_settings WHERE id`)).rows[0]!;

test('seal and unseal: random each time, tamper-proof, and old plain values still read', () => {
  const a = seal('re_supersecretkey123');
  const b = seal('re_supersecretkey123');
  assert.ok(isSealed(a) && isSealed(b));
  assert.notEqual(a, b, 'a fresh IV each time');
  assert.ok(!a!.includes('supersecret'));
  assert.equal(unseal(a), 're_supersecretkey123');
  assert.equal(seal(a), a, 'sealing twice is harmless');
  assert.equal(seal(null), null);
  assert.equal(unseal('legacy plain value'), 'legacy plain value');

  const warnings: string[] = [];
  setSecretKey(TEST_KEY, (m) => warnings.push(m));
  const raw = Buffer.from(a!.slice(7), 'base64');
  raw[20] = raw[20]! ^ 1;
  assert.equal(unseal(`enc:v1:${raw.toString('base64')}`, 'the Resend API key'), null, 'tampered values are rejected');

  setSecretKey('a-completely-different-key-0123456789abcdef', (m) => warnings.push(m));
  assert.equal(unseal(a, 'the Resend API key'), null, 'a different key can’t read it');
  assert.match(warnings.at(-1)!, /Couldn’t decrypt the Resend API key: the secret key is different/);
  setSecretKey(TEST_KEY);
  assert.throws(() => setSecretKey('short'), /at least 32 characters/);
});

test('the key: SECRET_KEY wins; otherwise a private key file is created once and reused', async () => {
  const file = path.join(dir, 'data', 'secret.key');
  const logs: string[] = [];
  assert.equal(await loadSecretKey(undefined, file, (m) => logs.push(m)), file);
  const first = (await readFile(file, 'utf8')).trim();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(logs[0]!, /Created .*secret\.key/);
  const sealed = seal('hello');
  await loadSecretKey('', file);
  assert.equal((await readFile(file, 'utf8')).trim(), first, 'reused, not replaced');
  assert.equal(unseal(sealed), 'hello');
  assert.equal(await loadSecretKey(TEST_KEY, file), 'SECRET_KEY');
  setSecretKey(TEST_KEY);
});

test('settings saved from the admin panel are encrypted in the database and work as usual', async () => {
  const config = testConfig({ mediaDir: dir });
  await saveSiteSettings(db, config, { smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'me', password: 'smtp-pass-123', from: 'A <a@example.com>' } });
  let r = await site();
  assert.ok(isSealed(r.smtp_password));
  assert.equal(config.mail?.provider === 'smtp' && config.mail.smtp.password, 'smtp-pass-123');

  await saveSiteSettings(db, config, { resend: { apiKey: 're_abcdefgh12345', from: 'A <a@example.com>' } });
  r = await site();
  assert.ok(isSealed(r.resend_api_key));
  assert.equal(config.mail?.provider === 'resend' && config.mail.apiKey, 're_abcdefgh12345');

  await changeStorage(db, config, { provider: 'r2', settings: { accountId: '0123456789abcdef0123456789abcdef', accessKeyId: 'AK', bucket: 'media', publicUrl: 'https://media.example.com' }, secret: 'r2-media-secret' }, (await db.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ('x@example.com', 'x') RETURNING id`)).rows[0]!.id);
  r = await site();
  assert.ok(isSealed(r.storage_secret));
  assert.equal(config.storage.secret, 'r2-media-secret');

  await saveBackupSettings(db, { passphrase: 'correct horse battery staple', storage: { provider: 'b2', settings: { endpoint: 's3.us-west-004.backblazeb2.com', accessKeyId: 'K', bucket: 'backups' }, secret: 'b2-secret' } });
  r = await site();
  assert.ok(isSealed(r.backup_passphrase) && isSealed(r.backup_storage_secret));
  assert.ok(!JSON.stringify(r).match(/smtp-pass-123|re_abcdefgh12345|r2-media-secret|correct horse|b2-secret/), 'no secret is stored readable');
});

test('upgrading: secrets saved before encryption are encrypted at startup; finished moves forget their keys', async () => {
  await db.query(`UPDATE site_settings SET smtp_password = 'old-plain-pass', storage_secret = 'old-plain-key', backup_passphrase = NULL`);
  const state = (secret: string | null) => JSON.stringify({ provider: 'r2', settings: { bucket: 'b' }, secret });
  await db.query(`INSERT INTO storage_moves (from_state, to_state, status) VALUES ($1, $2, 'done'), ($3, $4, 'queued')`,
    [state('done-from'), state('done-to'), state(null), state('queued-to')]);

  const config = testConfig({ mediaDir: dir });
  await loadSiteSettings(db, config);
  assert.equal(config.storage.secret, 'old-plain-key', 'plain values still work before the sweep');

  assert.ok((await encryptStoredSecrets(db)) >= 4);
  const r = await site();
  assert.ok(isSealed(r.smtp_password) && isSealed(r.storage_secret));
  await loadSiteSettings(db, config);
  assert.equal(config.storage.secret, 'old-plain-key');
  assert.equal(config.mail?.provider === 'resend' ? 'resend' : config.mail?.smtp.password, 'resend', 'mail provider unchanged');

  const moves = (await db.query<{ status: string; from_state: any; to_state: any }>(`SELECT status, from_state, to_state FROM storage_moves ORDER BY status`)).rows;
  const done = moves.find((m) => m.status === 'done')!;
  const queued = moves.find((m) => m.status === 'queued')!;
  assert.equal(done.from_state.secret, null);
  assert.equal(done.to_state.secret, null);
  assert.ok(isSealed(queued.to_state.secret));
  assert.equal(unseal(queued.to_state.secret), 'queued-to');
  assert.equal(await encryptStoredSecrets(db), 0, 'nothing left to do the second time');
});
