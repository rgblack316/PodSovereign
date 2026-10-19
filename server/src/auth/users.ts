import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { maybeOne, one, type Db, type Queryable } from '../db/db.js';
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './passwords.js';

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: Date;
}

const USER_COLS = 'id, email, display_name, is_admin, created_at';

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) throw new AuthError('Enter a valid email address');
  return email.trim().toLowerCase();
}

async function insertUser(q: Queryable, email: string, password: string, displayName: string | null, isAdmin: boolean) {
  const problem = passwordProblem(password);
  if (problem) throw new AuthError(problem);
  const hash = await hashPassword(password);
  try {
    return await one<User>(
      q,
      `INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, $2, $3, $4) RETURNING ${USER_COLS}`,
      [email, hash, displayName?.trim() || null, isAdmin],
    );
  } catch (e) {
    if (/23505|duplicate key/.test((e as Error).message) || (e as { code?: string }).code === '23505') {
      throw new AuthError('An account with that email already exists', 409);
    }
    throw e;
  }
}

/**
 * Self-registration. The very first account is always allowed and becomes the
 * server admin; after that it depends on ALLOW_REGISTRATION.
 */
export async function registerUser(
  db: Db,
  config: Config,
  input: { email: unknown; password: unknown; displayName?: unknown },
): Promise<User> {
  const email = normalizeEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.slice(0, 100) : null;
  return db.tx(async (q) => {
    // Serialise registrations so two people can't both become "the first user".
    await q.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const { rows } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    const first = rows[0]!.n === 0;
    if (!first && !config.allowRegistration) throw new AuthError('Registration is closed. Ask the server admin for an account.', 403);
    return insertUser(q, email, password, displayName, first);
  });
}

export async function createUserAsAdmin(
  db: Db,
  input: { email: unknown; password: unknown; displayName?: unknown; isAdmin?: unknown },
): Promise<User> {
  return insertUser(
    db,
    normalizeEmail(input.email),
    typeof input.password === 'string' ? input.password : '',
    typeof input.displayName === 'string' ? input.displayName.slice(0, 100) : null,
    input.isAdmin === true,
  );
}

/** Returns the user if the email/password match, else null (same timing either way). */
export async function authenticate(db: Db, email: string, password: string): Promise<User | null> {
  const row = await maybeOne<User & { password_hash: string }>(
    db,
    `SELECT ${USER_COLS}, password_hash FROM users WHERE email = $1`,
    [email],
  );
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
  if (!row || !ok) return null;
  const { password_hash: _, ...user } = row;
  return user;
}

export async function changePassword(db: Db, userId: string, current: string, next: string, keepSessionId: string) {
  const row = await one<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE id = $1`, [userId]);
  if (!(await verifyPassword(current, row.password_hash))) throw new AuthError('Current password is incorrect', 403);
  const problem = passwordProblem(next);
  if (problem) throw new AuthError(problem);
  await db.tx(async (q) => {
    await q.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, await hashPassword(next)]);
    // Sign out everywhere else.
    await q.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [userId, keepSessionId]);
  });
}

// ───────────── Sessions ─────────────

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export async function createSession(db: Db, userId: string, days: number, userAgent?: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [hashToken(token), userId, days, userAgent?.slice(0, 300) ?? null],
  );
  // Housekeeping
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  return token;
}

export async function sessionUser(db: Db, token: string): Promise<{ user: User; sessionId: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = hashToken(token);
  const row = await maybeOne<User & { last_seen_at: Date }>(
    db,
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  }
  const { last_seen_at: _, ...user } = row;
  return { user, sessionId: id };
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}
