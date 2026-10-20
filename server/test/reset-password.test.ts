import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { authenticate, createSession } from '../src/auth/users.js';
import { hashPassword } from '../src/auth/passwords.js';
import { newPassword, ResetError, resetPassword } from '../src/cli/reset-password.js';
import type { Db } from '../src/db/db.js';
import { setupDb } from './support/env.js';

let db: Db;
before(async () => {
  db = await setupDb('feedhost_reset_test');
});
after(async () => db.close());

test('with no accounts it says so', async () => {
  await assert.rejects(resetPassword(db), /no accounts yet/);
});

test('resets the only admin, signs out their sessions, and the new password works', async () => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, is_admin) VALUES ('randy@example.com', $1, true) RETURNING id`,
    [await hashPassword('forgotten password')],
  );
  await createSession(db, rows[0]!.id, 30);
  const r = await resetPassword(db);
  assert.equal(r.email, 'randy@example.com');
  assert.match(r.password, /^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
  assert.ok(await authenticate(db, 'randy@example.com', r.password));
  assert.equal(await authenticate(db, 'randy@example.com', 'forgotten password'), null);
  assert.equal((await db.query(`SELECT 1 FROM sessions`)).rows.length, 0);
});

test('with several admins it asks which one; an email picks the account', async () => {
  await db.query(`INSERT INTO users (email, password_hash, is_admin) VALUES ('other@example.com', 'x', true)`);
  await assert.rejects(resetPassword(db), (e: Error) => e instanceof ResetError && /randy@example.com \(admin\)/.test(e.message));
  const r = await resetPassword(db, 'Other@Example.com');
  assert.equal(r.email, 'other@example.com');
  await assert.rejects(resetPassword(db, 'nobody@example.com'), /No account/);
});

test('generated passwords are long enough and different each time', () => {
  const a = newPassword();
  assert.ok(a.length >= 20);
  assert.notEqual(a, newPassword());
});
