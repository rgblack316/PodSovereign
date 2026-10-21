/**
 * Set a new password for an account, from the server's terminal:
 *
 *   cd /opt/podsovereign && sudo docker compose exec app node --import tsx src/cli/reset-password.ts [email]
 *
 * Without an email, it resets the only admin (or lists the accounts if there's
 * more than one). Prints a new random password; sign in with it, then change it
 * under Account. Every session for that account is signed out.
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../auth/passwords.js';
import { normalizeEmail } from '../auth/users.js';
import type { Db } from '../db/db.js';

export class ResetError extends Error {}

/** Readable random password: 4 groups of 5 letters/digits, no look-alike characters. */
export function newPassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(20);
  const s = [...bytes].map((b) => chars[b % chars.length]).join('');
  return s.match(/.{5}/g)!.join('-');
}

export async function resetPassword(db: Db, email?: string): Promise<{ email: string; password: string }> {
  let user: { id: string; email: string } | undefined;
  if (email) {
    user = (await db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE email = $1`, [normalizeEmail(email)])).rows[0];
    if (!user) throw new ResetError(`No account with the email ${email}.`);
  } else {
    const admins = (await db.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE is_admin ORDER BY created_at`)).rows;
    if (admins.length !== 1) {
      const all = (await db.query<{ email: string; is_admin: boolean }>(`SELECT email, is_admin FROM users ORDER BY created_at`)).rows;
      throw new ResetError(
        all.length
          ? `Say which account to reset, e.g. reset-password ${all[0]!.email}\nAccounts:\n${all.map((u) => `  ${u.email}${u.is_admin ? ' (admin)' : ''}`).join('\n')}`
          : 'There are no accounts yet. Open the site to create the first one.',
      );
    }
    user = admins[0];
  }
  const password = newPassword();
  await db.tx(async (q) => {
    await q.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [user!.id, await hashPassword(password)]);
    await q.query(`DELETE FROM sessions WHERE user_id = $1`, [user!.id]);
  });
  return { email: user!.email, password };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadConfig } = await import('../config.js');
  const { createPgDb } = await import('../db/pg.js');
  const db = createPgDb(loadConfig().databaseUrl, 1);
  try {
    const r = await resetPassword(db, process.argv[2]);
    console.log(`\nNew password for ${r.email}:\n\n    ${r.password}\n\nSign in with it, then choose your own under Account. Other sessions for this account were signed out.\n`);
  } catch (e) {
    console.error(e instanceof ResetError ? e.message : e);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
