/**
 * Database dumps with pg_dump, gzipped, and optional passphrase encryption.
 *
 * The output is a plain SQL dump (`--clean --if-exists`), the same format
 * update.sh writes, so restoring is one command:
 *
 *   gunzip -c backup.sql.gz | docker compose exec -T db psql -U feedhost -d feedhost
 *
 * Encrypted backups use OpenSSL's own file format, so the standard tool decrypts them:
 *
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in backup.sql.gz.enc -out backup.sql.gz
 */
import { spawn } from 'node:child_process';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

export class DumpError extends Error {}

export const PBKDF2_ITER = 200_000;

/** pg_dump connection: the URL without its password (which goes in PGPASSWORD, not on the command line). */
function connection(databaseUrl: string): { url: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const u = new URL(databaseUrl);
    if (u.password) {
      env.PGPASSWORD = decodeURIComponent(u.password);
      u.password = '';
    }
    return { url: u.toString(), env };
  } catch {
    return { url: databaseUrl, env };
  }
}

/** Is pg_dump installed (and which version)? */
export async function pgDumpVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn('pg_dump', ['--version']);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

/**
 * Stream a gzipped SQL dump. The stream errors (with pg_dump's own message)
 * if pg_dump fails, so a half-written backup is never mistaken for a good one.
 */
export function dumpStream(databaseUrl: string): Readable {
  const { url, env } = connection(databaseUrl);
  const out = new PassThrough();
  const p = spawn('pg_dump', ['--no-owner', '--no-privileges', '--clean', '--if-exists', '--quote-all-identifiers', `--dbname=${url}`], { env });
  let stderr = '';
  p.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  p.on('error', (e) => out.destroy(new DumpError(
    (e as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'pg_dump isn’t installed in the app. Run the update (update.sh) to rebuild it with the PostgreSQL tools.'
      : `Couldn’t start pg_dump: ${e.message}`,
  )));
  const gzip = createGzip({ level: 9 });
  p.stdout.pipe(gzip);
  let exited: number | null | undefined;
  let gzipDone = false;
  const finish = () => {
    if (exited === undefined || !gzipDone) return;
    if (exited === 0) out.end();
    else out.destroy(new DumpError(`pg_dump failed: ${stderr.trim().split('\n').pop() || `exit code ${exited}`}`));
  };
  gzip.on('data', (c) => out.write(c));
  gzip.on('end', () => { gzipDone = true; finish(); });
  gzip.on('error', (e) => out.destroy(e));
  p.on('close', (code) => { exited = code; finish(); });
  return out;
}

export async function dumpBuffer(databaseUrl: string, maxBytes = 512 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of dumpStream(databaseUrl)) {
    n += (c as Buffer).length;
    if (n > maxBytes) throw new DumpError('The backup is larger than expected; download it from the admin panel instead');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Encrypt in OpenSSL's `enc` format: "Salted__" + 8-byte salt + AES-256-CBC ciphertext,
 * with the key and IV derived by PBKDF2-SHA256 (decrypt with `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256`).
 */
export function encryptOpenSsl(data: Buffer, passphrase: string, iter = PBKDF2_ITER): Buffer {
  const salt = randomBytes(8);
  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iter, 48, 'sha256');
  const cipher = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__', 'latin1'), salt, cipher.update(data), cipher.final()]);
}

/** The same encryption as a stream (for downloads): writes the OpenSSL header, then the ciphertext. */
export function encryptStream(passphrase: string, iter = PBKDF2_ITER): Transform {
  const salt = randomBytes(8);
  const derived = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iter, 48, 'sha256');
  const cipher = createCipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  let started = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!started) {
        this.push(Buffer.concat([Buffer.from('Salted__', 'latin1'), salt]));
        started = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!started) this.push(Buffer.concat([Buffer.from('Salted__', 'latin1'), salt]));
      cb(null, cipher.final());
    },
  });
}

/** podsovereign-db-2026-10-21-030000.sql.gz (UTC time), plus .enc when encrypted. */
export function backupFileName(when = new Date(), encrypted = false): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getUTCFullYear()}-${p(when.getUTCMonth() + 1)}-${p(when.getUTCDate())}-${p(when.getUTCHours())}${p(when.getUTCMinutes())}${p(when.getUTCSeconds())}`;
  return `podsovereign-db-${stamp}.sql.gz${encrypted ? '.enc' : ''}`;
}
