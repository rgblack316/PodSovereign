/**
 * Backups from the admin panel: a download on demand, and automatic backups
 * on a schedule, sent off the server by email (to the administrators) and/or
 * to a private Cloudflare R2 bucket that keeps the most recent N.
 */
import type { Config } from '../config.js';
import { maybeOne, one, type Db, type Queryable } from '../db/db.js';
import { sendEmail } from '../mail/mailer.js';
import { S3Client } from '../storage/s3.js';
import { backupFileName, dumpBuffer, encryptOpenSsl } from './dump.js';

export class BackupError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Most email services refuse messages much bigger than this (Resend: 40 MB, Gmail: 25 MB, after base64). */
export const EMAIL_MAX_BYTES = 18 * 1024 * 1024;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Row {
  backup_frequency: 'off' | 'daily' | 'weekly';
  backup_hour: number;
  backup_weekday: number;
  backup_timezone: string;
  backup_email: boolean;
  backup_email_to: string | null;
  backup_r2: { accountId?: string; accessKeyId?: string; bucket?: string; prefix?: string } | null;
  backup_r2_secret: string | null;
  backup_keep: number;
  backup_passphrase: string | null;
  backup_next_at: Date | null;
}

const getRow = (q: Queryable) =>
  one<Row>(q, `SELECT backup_frequency, backup_hour, backup_weekday, backup_timezone, backup_email, backup_email_to,
                      backup_r2, backup_r2_secret, backup_keep, backup_passphrase, backup_next_at FROM site_settings WHERE id`);

const r2Ready = (r: Row) => !!(r.backup_r2?.accountId && r.backup_r2?.accessKeyId && r.backup_r2?.bucket && r.backup_r2_secret);

function r2Client(cfg: { accountId: string; accessKeyId: string; bucket: string }, secret: string): S3Client {
  return new S3Client({
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
    bucket: cfg.bucket,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: secret,
    pathStyle: true,
  });
}

/** Tests point R2 at a fake server. */
export const r2Override: { endpoint: string | null } = { endpoint: null };
function client(r: Row): S3Client {
  const c = r.backup_r2!;
  if (r2Override.endpoint) {
    return new S3Client({ endpoint: r2Override.endpoint, region: 'auto', bucket: c.bucket!, accessKeyId: c.accessKeyId!, secretAccessKey: r.backup_r2_secret!, pathStyle: true });
  }
  return r2Client({ accountId: c.accountId!, accessKeyId: c.accessKeyId!, bucket: c.bucket! }, r.backup_r2_secret!);
}

const prefixOf = (r: Row) => {
  const p = (r.backup_r2?.prefix ?? 'podsovereign-backups/').trim().replace(/^\/+/, '');
  return p && !p.endsWith('/') ? `${p}/` : p;
};

// ───────────── schedule ─────────────

/** Hour, minute and weekday of a moment in a time zone. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(d: Date, timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    formatters.set(timeZone, f);
  }
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!) };
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The next time the schedule fires after `from` (to the minute), or null when backups are off. */
export function nextRun(s: { frequency: string; hour: number; weekday: number; timezone: string }, from = new Date()): Date | null {
  if (s.frequency === 'off') return null;
  const tz = validTimeZone(s.timezone) ? s.timezone : 'UTC';
  // Walk forward a minute at a time from the next whole minute (at most 8 days; cheap enough).
  const t = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 8 * 24 * 60; i++, t.setTime(t.getTime() + 60_000)) {
    const p = localParts(t, tz);
    if (p.minute === 0 && p.hour === s.hour && (s.frequency === 'daily' || p.weekday === s.weekday)) return new Date(t);
  }
  return null;
}

// ───────────── settings ─────────────

export async function backupView(db: Db, config: Config) {
  const r = await getRow(db);
  const { rows: runs } = await db.query<Record<string, unknown>>(
    `SELECT id, trigger, status, file_name AS "fileName", bytes, encrypted, results, error, created_at AS "createdAt", finished_at AS "finishedAt"
       FROM backup_runs ORDER BY created_at DESC LIMIT 10`,
  );
  const admins = (await db.query<{ email: string }>(`SELECT email FROM users WHERE is_admin ORDER BY created_at`)).rows.map((u) => u.email);
  return {
    schedule: { frequency: r.backup_frequency, hour: r.backup_hour, weekday: r.backup_weekday, timezone: r.backup_timezone, nextAt: r.backup_next_at },
    email: { enabled: r.backup_email, to: r.backup_email_to, admins, mailConfigured: !!config.mail },
    r2: { accountId: r.backup_r2?.accountId ?? '', accessKeyId: r.backup_r2?.accessKeyId ?? '', bucket: r.backup_r2?.bucket ?? '', prefix: r.backup_r2?.prefix ?? 'podsovereign-backups/', secretSet: !!r.backup_r2_secret, ready: r2Ready(r) },
    keep: r.backup_keep,
    passphraseSet: !!r.backup_passphrase,
    runs: runs.map((x) => ({ ...x, bytes: x.bytes === null ? null : Number(x.bytes) })),
  };
}

export interface BackupInput {
  frequency?: unknown;
  hour?: unknown;
  weekday?: unknown;
  timezone?: unknown;
  email?: unknown;
  emailTo?: unknown;
  r2?: unknown;
  keep?: unknown;
  /** New passphrase; '' or null removes it; undefined keeps it. */
  passphrase?: unknown;
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new BackupError(`${field} must be a whole number from ${min} to ${max}`);
  return n;
}

export async function saveBackupSettings(db: Db, input: BackupInput, now = new Date()): Promise<void> {
  await db.tx(async (q) => {
    const r = await getRow(q);
    const n: Row = { ...r, backup_r2: { ...(r.backup_r2 ?? {}) } };
    if (input.frequency !== undefined) {
      if (!['off', 'daily', 'weekly'].includes(input.frequency as string)) throw new BackupError('Frequency must be off, daily or weekly');
      n.backup_frequency = input.frequency as Row['backup_frequency'];
    }
    if (input.hour !== undefined) n.backup_hour = int(input.hour, 'Hour', 0, 23);
    if (input.weekday !== undefined) n.backup_weekday = int(input.weekday, 'Day of the week', 0, 6);
    if (input.timezone !== undefined) {
      if (typeof input.timezone !== 'string' || !validTimeZone(input.timezone)) throw new BackupError('Unknown time zone');
      n.backup_timezone = input.timezone;
    }
    if (input.email !== undefined) {
      if (typeof input.email !== 'boolean') throw new BackupError('email must be true or false');
      n.backup_email = input.email;
    }
    if (input.emailTo !== undefined) {
      const to = typeof input.emailTo === 'string' ? input.emailTo.trim() : '';
      if (to && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new BackupError('Send backups to: enter an email address, or leave it blank for every administrator');
      n.backup_email_to = to || null;
    }
    if (input.r2 !== undefined) {
      if (input.r2 === null) {
        n.backup_r2 = {};
        n.backup_r2_secret = null;
      } else {
        const o = (input.r2 ?? {}) as Record<string, unknown>;
        const t = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
        const accountId = t(o.accountId);
        if (accountId && !/^[0-9a-f]{32}$/i.test(accountId)) throw new BackupError('The R2 account ID is the 32-character ID from the Cloudflare dashboard');
        const bucket = t(o.bucket);
        if (bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new BackupError('Bucket names use lowercase letters, numbers and dashes');
        const prefix = t(o.prefix);
        if (prefix && !/^[A-Za-z0-9._\/-]{1,200}$/.test(prefix)) throw new BackupError('The folder may use letters, numbers, dots, dashes, underscores and slashes');
        n.backup_r2 = { accountId, accessKeyId: t(o.accessKeyId), bucket, prefix: prefix || 'podsovereign-backups/' };
        if (t(o.secret)) n.backup_r2_secret = t(o.secret);
      }
    }
    if (input.keep !== undefined) n.backup_keep = int(input.keep, 'Backups to keep', 1, 365);
    if (input.passphrase !== undefined) {
      const p = typeof input.passphrase === 'string' ? input.passphrase : '';
      if (p && p.length < 12) throw new BackupError('Use a passphrase of at least 12 characters');
      if (p.length > 256) throw new BackupError('The passphrase is too long');
      n.backup_passphrase = p || null;
    }
    if (n.backup_frequency !== 'off' && !n.backup_email && !r2Ready(n)) {
      throw new BackupError('Choose where automatic backups go: email, an R2 bucket, or both');
    }
    const next = nextRun({ frequency: n.backup_frequency, hour: n.backup_hour, weekday: n.backup_weekday, timezone: n.backup_timezone }, now);
    await q.query(
      `UPDATE site_settings SET backup_frequency = $1, backup_hour = $2, backup_weekday = $3, backup_timezone = $4,
              backup_email = $5, backup_email_to = $6, backup_r2 = $7, backup_r2_secret = $8, backup_keep = $9,
              backup_passphrase = $10, backup_next_at = $11, updated_at = now() WHERE id`,
      [n.backup_frequency, n.backup_hour, n.backup_weekday, n.backup_timezone, n.backup_email, n.backup_email_to,
        JSON.stringify(n.backup_r2), n.backup_r2_secret, n.backup_keep, n.backup_passphrase, next?.toISOString() ?? null],
    );
  });
}

/** Upload a small file, read it back, list it, delete it. */
export async function testBucket(db: Db): Promise<{ ok: boolean; steps: { step: string; ok: boolean; detail: string }[] }> {
  const r = await getRow(db);
  if (!r2Ready(r)) throw new BackupError('Save the R2 account ID, access key, secret and bucket first');
  const c = client(r);
  const key = `${prefixOf(r)}_connection-test-${Date.now()}.txt`;
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  const run = async (step: string, fn: () => Promise<string>) => {
    try {
      steps.push({ step, ok: true, detail: await fn() });
      return true;
    } catch (e) {
      steps.push({ step, ok: false, detail: (e as Error).message });
      return false;
    }
  };
  const body = Buffer.from(`PodSovereign backup test ${new Date().toISOString()}\n`);
  (await run('Upload', async () => { await c.putBuffer(key, body, 'text/plain'); return 'A test file was uploaded.'; })) &&
    (await run('Read back', async () => {
      const got = await c.getBuffer(key);
      if (!got.equals(body)) throw new Error('The file came back different');
      return 'It reads back correctly.';
    })) &&
    (await run('List', async () => { const keys = await c.list(prefixOf(r)); return `The backup folder lists ${keys.length} file${keys.length === 1 ? '' : 's'} (old backups can be pruned).`; }));
  await run('Clean up', async () => { await c.delete(key); return 'The test file was deleted.'; });
  return { ok: steps.every((s) => s.ok), steps };
}

// ───────────── running a backup ─────────────

export async function startRun(db: Queryable, trigger: 'download' | 'manual' | 'scheduled', userId: string | null, fileName: string, encrypted: boolean) {
  return (await one<{ id: string }>(
    db,
    `INSERT INTO backup_runs (trigger, file_name, encrypted, user_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [trigger, fileName, encrypted, userId],
  )).id;
}

export async function finishRun(db: Queryable, id: string, r: { status: 'done' | 'failed'; bytes?: number; results?: unknown[]; error?: string | null }) {
  await db.query(
    `UPDATE backup_runs SET status = $2, bytes = $3, results = $4, error = $5, finished_at = now() WHERE id = $1`,
    [id, r.status, r.bytes ?? null, JSON.stringify(r.results ?? []), r.error ?? null],
  );
  // Keep the history short.
  await db.query(`DELETE FROM backup_runs WHERE id NOT IN (SELECT id FROM backup_runs ORDER BY created_at DESC LIMIT 50)`);
}

/**
 * Make a backup and send it wherever automatic backups go (email and/or R2).
 * Returns the run record. Each destination is tried even if another fails.
 */
export async function runBackup(db: Db, config: Config, trigger: 'manual' | 'scheduled', userId: string | null = null, now = new Date()) {
  const r = await getRow(db);
  if (!r.backup_email && !r2Ready(r)) throw new BackupError('Set up email or an R2 bucket for backups first');
  const encrypted = !!r.backup_passphrase;
  const fileName = backupFileName(now, encrypted);
  const runId = await startRun(db, trigger, userId, fileName, encrypted);
  const results: { to: string; ok: boolean; detail: string }[] = [];
  try {
    let data = await dumpBuffer(config.databaseUrl);
    if (encrypted) data = encryptOpenSsl(data, r.backup_passphrase!);
    const size = `${(data.length / 1024 / 1024).toFixed(1)} MB`;

    if (r.backup_email) {
      const to = r.backup_email_to
        ? [r.backup_email_to]
        : (await db.query<{ email: string }>(`SELECT email FROM users WHERE is_admin ORDER BY created_at`)).rows.map((u) => u.email);
      if (!config.mail) results.push({ to: 'email', ok: false, detail: 'Email isn’t set up (Site settings → Email)' });
      else if (data.length > EMAIL_MAX_BYTES) results.push({ to: 'email', ok: false, detail: `The backup is ${size}, too big to email. Use an R2 bucket.` });
      else {
        for (const addr of to) {
          try {
            await sendEmail(config, {
              to: addr,
              subject: `${config.siteName} backup ${fileName.match(/\d{4}-\d\d-\d\d/)?.[0] ?? ''}`.trim(),
              text: [
                `Attached is a database backup of ${config.siteName} (${config.publicBaseUrl}), ${size}.`,
                '',
                encrypted
                  ? 'It is encrypted with your backup passphrase. To decrypt it:\n  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in FILE.enc -out FILE'
                  : 'It isn’t encrypted. It contains your shows, accounts (passwords are hashed) and saved service keys, so keep it somewhere private.',
                '',
                'To restore it, see "Backups and restore" in the README.',
                '',
                'PodSovereign: Your podcast. Your platform. Your rules.',
              ].join('\n'),
              attachments: [{ filename: fileName, contentType: encrypted ? 'application/octet-stream' : 'application/gzip', content: data }],
            });
            results.push({ to: 'email', ok: true, detail: `Sent to ${addr}` });
          } catch (e) {
            results.push({ to: 'email', ok: false, detail: `${addr}: ${(e as Error).message}` });
          }
        }
      }
    }

    if (r2Ready(r)) {
      try {
        const c = client(r);
        const prefix = prefixOf(r);
        await c.putBuffer(`${prefix}${fileName}`, data, encrypted ? 'application/octet-stream' : 'application/gzip');
        // Keep the newest N (names sort by time).
        const old = (await c.list(prefix)).filter((k) => /podsovereign-db-[\d-]+\.sql\.gz(\.enc)?$/.test(k)).sort().reverse().slice(r.backup_keep);
        for (const k of old) await c.delete(k);
        results.push({ to: 'r2', ok: true, detail: `Uploaded to ${r.backup_r2!.bucket}/${prefix}${fileName}${old.length ? `; removed ${old.length} older` : ''}` });
      } catch (e) {
        results.push({ to: 'r2', ok: false, detail: `R2: ${(e as Error).message}` });
      }
    }

    const ok = results.length > 0 && results.every((x) => x.ok);
    await finishRun(db, runId, { status: ok ? 'done' : 'failed', bytes: data.length, results, error: ok ? null : results.filter((x) => !x.ok).map((x) => x.detail).join('; ') });
  } catch (e) {
    await finishRun(db, runId, { status: 'failed', results, error: (e as Error).message });
  }
  return (await maybeOne<Record<string, unknown>>(
    db,
    `SELECT id, trigger, status, file_name AS "fileName", bytes, encrypted, results, error, created_at AS "createdAt" FROM backup_runs WHERE id = $1`,
    [runId],
  ))!;
}

/** Called every minute: run the scheduled backup when it's due. */
export async function runDueBackup(db: Db, config: Config, now = new Date(), log?: (m: string) => void): Promise<boolean> {
  const r = await getRow(db);
  if (r.backup_frequency === 'off' || !r.backup_next_at || new Date(r.backup_next_at).getTime() > now.getTime()) return false;
  // Move the next time on first, so a slow or failed backup isn't repeated every minute.
  const next = nextRun({ frequency: r.backup_frequency, hour: r.backup_hour, weekday: r.backup_weekday, timezone: r.backup_timezone }, now);
  const claimed = await db.query(`UPDATE site_settings SET backup_next_at = $1 WHERE id AND backup_next_at = $2`, [next?.toISOString() ?? null, r.backup_next_at]);
  if (!claimed.rowCount) return false;
  const run = await runBackup(db, config, 'scheduled', null, now).catch((e) => ({ status: 'failed', error: (e as Error).message }));
  log?.(`backup: ${run.status}${run.error ? ` (${run.error})` : ''}`);
  return true;
}

export function describeSchedule(s: { frequency: string; hour: number; weekday: number; timezone: string }): string {
  if (s.frequency === 'off') return 'Off';
  const h = `${String(s.hour).padStart(2, '0')}:00`;
  return s.frequency === 'daily' ? `Daily at ${h} (${s.timezone})` : `${WEEKDAYS[s.weekday]}s at ${h} (${s.timezone})`;
}

export function startBackupWorker(deps: { db: Db; config: Config; log?: (m: string) => void }, everyMs = 60_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDueBackup(deps.db, deps.config, new Date(), deps.log)
      .catch((e) => deps.log?.(`backup worker: ${(e as Error).message}`))
      .finally(() => (running = false));
  }, everyMs);
  return { stop: () => clearInterval(timer) };
}
