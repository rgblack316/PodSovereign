/**
 * Password hashing with Node's built-in scrypt (memory-hard; no native
 * dependency to compile on the server). Stored as:
 *   scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;

function scrypt(pw: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((res, rej) => scryptCb(pw, salt, keylen, opts, (e, k) => (e ? rej(e) : res(k))));
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

/** Returns an error message, or null if the password is acceptable. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (pw.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const key = await scrypt(pw.normalize('NFKC'), salt, expected.length, { N: n, r, p, maxmem: 128 * n * r * 2 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A real hash to verify against when the account doesn't exist, so timing doesn't reveal which emails are registered. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
