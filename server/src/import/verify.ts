/**
 * Ownership verification: before a show is imported, the person importing it
 * proves they control it, by either
 *  - adding a token to the feed at their current host, as
 *    <podcast:txt purpose="verify">TOKEN</podcast:txt> (or in the description,
 *    for hosts without custom tags), or
 *  - entering a code emailed to the feed's owner address (<itunes:owner>).
 * Admins can skip it for shows they manage.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import { maybeOne, type Db } from '../db/db.js';
import { parseFeed } from '../feed/parser.js';
import type { Feed } from '../feed/types.js';
import { sendMail } from '../mail/smtp.js';
import { fetchFeedText, withRetry } from './http.js';

export class VerifyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const CODE_TTL_MIN = 30;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 5;
const RESEND_AFTER_SEC = 60;
export const VERIFY_EXPIRES_DAYS = 7;

export const newToken = () => `feedhost-verify-${randomBytes(12).toString('base64url')}`;

/** The token in <podcast:txt>, the description, or <itunes:summary>. */
export function feedHasToken(feed: Feed, token: string): boolean {
  const c = feed.channel;
  if (c.extra.some((n) => n.name === 'podcast:txt' && n.text.trim() === token)) return true;
  if (c.description?.includes(token)) return true;
  return c.extra.some((n) => n.name === 'itunes:summary' && n.text.includes(token));
}

const EMAIL_RE = /[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+/;

/** Owner email from <itunes:owner>, falling back to <managingEditor>. */
export function ownerEmail(feed: Feed): string | null {
  const own = feed.channel.itunesOwnerEmail?.trim();
  if (own && EMAIL_RE.test(own)) return EMAIL_RE.exec(own)![0].toLowerCase();
  const me = feed.channel.extra.find((n) => n.name === 'managingEditor')?.text;
  const m = me ? EMAIL_RE.exec(me) : null;
  return m ? m[0].toLowerCase() : null;
}

/** r••••@example.com — enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user!.slice(0, 1)}${'•'.repeat(Math.min(6, Math.max(2, user!.length - 1)))}@${domain}`;
}

export interface Preview {
  title: string;
  author: string | null;
  imageUrl: string | null;
  episodes: number;
  ownerEmail: string | null; // masked
}

export function previewOf(feed: Feed): Preview {
  const email = ownerEmail(feed);
  return {
    title: feed.channel.title,
    author: feed.channel.itunesAuthor,
    imageUrl: feed.channel.imageUrl,
    episodes: feed.items.length,
    ownerEmail: email ? maskEmail(email) : null,
  };
}

const codeHash = (jobId: string, code: string) => createHash('sha256').update(`${jobId}:${code}`).digest('hex');

interface VerifyRow {
  id: string;
  user_id: string;
  status: string;
  source_url: string;
  verify_token: string | null;
  verify_email: string | null;
  verify_code_hash: string | null;
  verify_code_expires: Date | null;
  verify_sends: number;
  verify_attempts: number;
  preview: Preview | null;
  created_at: Date;
}

async function verifyingJob(db: Db, jobId: string, userId: string): Promise<VerifyRow> {
  const row = /^[0-9a-f-]{36}$/i.test(jobId)
    ? await maybeOne<VerifyRow>(
        db,
        `SELECT id, user_id, status, source_url, verify_token, verify_email, verify_code_hash, verify_code_expires, verify_sends, verify_attempts, preview, created_at
           FROM import_jobs WHERE id = $1 AND user_id = $2`,
        [jobId, userId],
      )
    : null;
  if (!row) throw new VerifyError('Import not found', 404);
  if (row.status !== 'verifying') throw new VerifyError('This import isn’t waiting for verification', 409);
  return row;
}

/** Verified: queue the job to run the real import. */
export async function markVerified(db: Db, jobId: string, method: 'feed' | 'email' | 'admin'): Promise<void> {
  await db.query(
    `UPDATE import_jobs SET status = 'queued', verified_at = now(), verified_method = $2,
            verify_code_hash = NULL, verify_code_expires = NULL, progress = '{"stage":"fetching"}'
      WHERE id = $1 AND status = 'verifying'`,
    [jobId, method],
  );
}

/** Re-read the feed at the current host and look for the token. */
export async function checkFeed(db: Db, config: Config, jobId: string, userId: string): Promise<{ verified: boolean; message: string }> {
  const job = await verifyingJob(db, jobId, userId);
  let feed: Feed;
  try {
    const { text } = await withRetry(() => fetchFeedText(job.source_url, { allowPrivate: config.allowPrivateNetworks, maxBytes: config.maxFeedBytes }), 2, 500);
    feed = parseFeed(text).feed;
  } catch (e) {
    return { verified: false, message: `Couldn't read the feed just now (${(e as Error).message}). Try again in a minute.` };
  }
  if (job.verify_token && feedHasToken(feed, job.verify_token)) {
    await markVerified(db, jobId, 'feed');
    return { verified: true, message: 'Found it. The import is starting.' };
  }
  return {
    verified: false,
    message: 'The code isn’t in the feed yet. Some hosts take a few minutes to update the feed after you save; check again shortly.',
  };
}

/** Email a 6-digit code to the feed's owner address. */
export async function sendCode(db: Db, config: Config, jobId: string, userId: string): Promise<{ sentTo: string }> {
  const job = await verifyingJob(db, jobId, userId);
  if (!config.smtp) throw new VerifyError('Email isn’t set up on this server yet. Use the feed tag instead, or ask an admin.');
  if (!job.verify_email) throw new VerifyError('This feed doesn’t list an owner email (<itunes:owner>), so use the feed tag instead.');
  if (job.verify_sends >= MAX_SENDS) throw new VerifyError('Too many codes sent for this import. Use the feed tag instead, or start the import again later.', 429);
  if (job.verify_code_expires) {
    const sentAgo = (Date.now() - (new Date(job.verify_code_expires).getTime() - CODE_TTL_MIN * 60_000)) / 1000;
    if (sentAgo < RESEND_AFTER_SEC) throw new VerifyError(`A code was just sent. You can send another in ${Math.ceil(RESEND_AFTER_SEC - sentAgo)} seconds.`, 429);
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const title = job.preview?.title ?? 'your podcast';
  await sendMail(config.smtp, {
    to: job.verify_email,
    subject: `${code} is your code to move ${title} to ${config.siteName}`,
    text: [
      `Someone is moving the podcast “${title}” to ${config.siteName} (${config.publicBaseUrl}).`,
      '',
      `If that's you, enter this code to confirm you own the show:`,
      '',
      `    ${code}`,
      '',
      `The code works for ${CODE_TTL_MIN} minutes.`,
      '',
      `If it isn't you, ignore this email. Nothing is copied or changed without the code, and your current feed keeps working.`,
    ].join('\n'),
  });
  await db.query(
    `UPDATE import_jobs SET verify_code_hash = $2, verify_code_expires = now() + make_interval(mins => $3),
            verify_sends = verify_sends + 1, verify_attempts = 0 WHERE id = $1`,
    [jobId, codeHash(jobId, code), CODE_TTL_MIN],
  );
  return { sentTo: maskEmail(job.verify_email) };
}

export async function checkCode(db: Db, jobId: string, userId: string, code: unknown): Promise<void> {
  const job = await verifyingJob(db, jobId, userId);
  const entered = typeof code === 'string' ? code.replace(/\s+/g, '') : '';
  if (!job.verify_code_hash || !job.verify_code_expires) throw new VerifyError('Send a code first.');
  if (job.verify_attempts >= MAX_ATTEMPTS) throw new VerifyError('Too many wrong codes. Send a new code.', 429);
  if (new Date(job.verify_code_expires).getTime() < Date.now()) throw new VerifyError('That code has expired. Send a new one.');
  await db.query(`UPDATE import_jobs SET verify_attempts = verify_attempts + 1 WHERE id = $1`, [jobId]);
  const a = Buffer.from(codeHash(jobId, entered), 'hex');
  const b = Buffer.from(job.verify_code_hash, 'hex');
  if (!/^\d{6}$/.test(entered) || a.length !== b.length || !timingSafeEqual(a, b)) {
    const left = MAX_ATTEMPTS - job.verify_attempts - 1;
    throw new VerifyError(left > 0 ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code isn’t right. Send a new code.');
  }
  await markVerified(db, jobId, 'email');
}

export async function cancelImport(db: Db, jobId: string, userId: string): Promise<void> {
  const mine = /^[0-9a-f-]{36}$/i.test(jobId)
    ? await maybeOne<{ status: string }>(db, `SELECT status FROM import_jobs WHERE id = $1 AND user_id = $2`, [jobId, userId])
    : null;
  if (!mine) throw new VerifyError('Import not found', 404);
  const r = await db.query(
    `UPDATE import_jobs SET status = 'failed', error = 'Cancelled', finished_at = now(), verify_code_hash = NULL
      WHERE id = $1 AND user_id = $2 AND status IN ('verifying', 'queued')`,
    [jobId, userId],
  );
  if (!r.rowCount) throw new VerifyError('Only imports that haven’t started copying can be cancelled', 409);
}

/** Give up on verifications nobody finished. */
export async function expireVerifications(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE import_jobs SET status = 'failed', error = 'Ownership wasn’t verified within ${VERIFY_EXPIRES_DAYS} days',
            finished_at = now(), verify_code_hash = NULL
      WHERE status = 'verifying' AND created_at < now() - make_interval(days => $1)`,
    [VERIFY_EXPIRES_DAYS],
  );
  return r.rowCount;
}

export { verifyingJob };
