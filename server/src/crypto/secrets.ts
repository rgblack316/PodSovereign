/**
 * Saved secrets (storage keys, SMTP password, Resend key, backup passphrase)
 * are encrypted in the database with AES-256-GCM. The key never goes in the
 * database: it comes from SECRET_KEY in the environment, or else from a key
 * file next to the media (/data/secret.key in Docker), created on first start.
 *
 * A database backup on its own therefore can't reveal those secrets; restoring
 * on another server needs the same key (or the secrets entered again).
 *
 * Stored form: "enc:v1:" + base64(12-byte IV | ciphertext | 16-byte tag).
 * Values without the prefix are from before encryption and are read as-is
 * until encryptStoredSecrets() seals them at startup.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/db.js';

const PREFIX = 'enc:v1:';
let key: Buffer | null = null;
let warn: (m: string) => void = (m) => console.warn(m);

export class SecretKeyError extends Error {}

/** Derive the AES key from the configured key material (any string of 32+ characters). */
export function setSecretKey(material: string, log?: (m: string) => void): void {
  const m = material.trim();
  if (m.length < 32) throw new SecretKeyError('SECRET_KEY must be at least 32 characters (use: openssl rand -hex 32)');
  key = Buffer.from(hkdfSync('sha256', Buffer.from(m, 'utf8'), Buffer.alloc(0), Buffer.from('podsovereign saved secrets v1'), 32));
  if (log) warn = log;
}

/** SECRET_KEY from the environment, or the key file (created if missing). Returns where it came from. */
export async function loadSecretKey(envValue: string | undefined, file: string, log?: (m: string) => void): Promise<string> {
  if (envValue?.trim()) {
    setSecretKey(envValue, log);
    return 'SECRET_KEY';
  }
  let material: string;
  try {
    material = (await readFile(file, 'utf8')).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new SecretKeyError(`Couldn’t read the key file ${file}: ${(e as Error).message}`);
    material = randomBytes(32).toString('hex');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${material}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600).catch(() => {});
    log?.(`Created ${file}, the key that encrypts saved passwords and API keys. Keep a copy with your backups.`);
  }
  setSecretKey(material, log);
  return file;
}

function needKey(): Buffer {
  if (!key) throw new SecretKeyError('The secret key isn’t loaded');
  return key;
}

export const isSealed = (v: string | null | undefined): boolean => typeof v === 'string' && v.startsWith(PREFIX);

/** Encrypt a secret for storage (null stays null; already-sealed values are left alone). */
export function seal(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === '') return null;
  if (isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', needKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

/**
 * Decrypt a stored secret. Values from before encryption are returned as-is.
 * If it can't be decrypted (the key changed), it's treated as not saved, so
 * the admin panel asks for it again instead of the app failing to start.
 */
export function unseal(stored: string | null | undefined, what = 'a saved secret'): string | null {
  if (stored === null || stored === undefined || stored === '') return null;
  if (!isSealed(stored)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    if (raw.length < 12 + 16) throw new Error('too short');
    const d = createDecipheriv('aes-256-gcm', needKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof SecretKeyError) throw e;
    warn(`Couldn’t decrypt ${what}: the secret key is different from the one it was saved with. Restore the original key (SECRET_KEY or secret.key), or enter it again in Site settings.`);
    return null;
  }
}

/** Seal the secret inside a storage state ({provider, settings, secret}). */
export const sealState = <T extends { secret: string | null }>(s: T): T => ({ ...s, secret: seal(s.secret) });
export const unsealState = <T extends { secret: string | null }>(s: T, what?: string): T => ({ ...s, secret: unseal(s.secret, what) });

const SITE_COLUMNS = ['storage_secret', 'smtp_password', 'resend_api_key', 'backup_storage_secret', 'backup_passphrase', 'op3_token'] as const;

/**
 * At startup: encrypt anything saved before encryption existed, and drop the
 * keys kept in finished media moves (they're not needed once a move is over).
 */
export async function encryptStoredSecrets(db: Db, log?: (m: string) => void): Promise<number> {
  let n = 0;
  const row = (await db.query<Record<string, string | null>>(`SELECT ${SITE_COLUMNS.join(', ')} FROM site_settings WHERE id`)).rows[0];
  if (row) {
    const todo = SITE_COLUMNS.filter((c) => row[c] && !isSealed(row[c]));
    if (todo.length) {
      await db.query(
        `UPDATE site_settings SET ${todo.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id`,
        todo.map((c) => seal(row[c])),
      );
      n += todo.length;
    }
  }
  const { rows: moves } = await db.query<{ id: string; status: string; from_state: { secret: string | null }; to_state: { secret: string | null } }>(
    `SELECT id, status, from_state, to_state FROM storage_moves`,
  );
  for (const m of moves) {
    const done = m.status === 'done' || m.status === 'failed';
    const fix = (s: { secret: string | null }) => (done ? { ...s, secret: null } : sealState(s));
    const from = fix(m.from_state);
    const to = fix(m.to_state);
    if (from.secret !== m.from_state.secret || to.secret !== m.to_state.secret) {
      await db.query(`UPDATE storage_moves SET from_state = $2, to_state = $3 WHERE id = $1`, [m.id, JSON.stringify(from), JSON.stringify(to)]);
      n++;
    }
  }
  if (n) log?.(`Encrypted ${n} saved secret${n === 1 ? '' : 's'}`);
  return n;
}
