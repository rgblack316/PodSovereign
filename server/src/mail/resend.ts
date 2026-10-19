/**
 * Resend (https://resend.com) email API: POST /emails with a Bearer API key.
 * The "From" address must be on a domain verified in Resend.
 */
import { randomUUID } from 'node:crypto';
import type { Mail } from './smtp.js';

export class ResendError extends Error {
  constructor(message: string, readonly status: number, readonly name_?: string) {
    super(message);
  }
}

export interface ResendConfig {
  apiKey: string;
  from: string;
  /** Override for tests. */
  apiUrl?: string;
}

export async function sendViaResend(cfg: ResendConfig, mail: Mail): Promise<{ id: string }> {
  const url = `${(cfg.apiUrl ?? 'https://api.resend.com').replace(/\/+$/, '')}/emails`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'FeedHost/0.1',
        // A retried request never sends the email twice.
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ from: cfg.from, to: [mail.to], subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new ResendError(`Couldn't reach Resend: ${(e as Error).message}`, 0);
  }
  const text = await res.text();
  let body: { id?: string; name?: string; message?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON */
  }
  if (res.ok && body.id) return { id: body.id };

  const msg = body.message ?? `HTTP ${res.status}`;
  const domain = (/@([^>\s]+)>?\s*$/.exec(cfg.from)?.[1] ?? '').toLowerCase();
  let hint = '';
  if (res.status === 401 || body.name === 'missing_api_key' || (res.status === 400 && /api key/i.test(msg))) {
    hint = 'Check the API key (it starts with re_ and needs Sending access).';
  } else if (res.status === 403 && /domain/i.test(msg)) {
    hint = `Verify ${domain || 'your sending domain'} at resend.com/domains, and send from an address on it.`;
  } else if (res.status === 403 && /testing|own email/i.test(msg)) {
    hint = 'Resend’s test sender (onboarding@resend.dev) can only email your own Resend address. Verify your domain to email podcasters.';
  } else if (res.status === 403) {
    hint = 'The API key may be inactive or restricted.';
  } else if (res.status === 429) {
    hint = body.name === 'rate_limit_exceeded' ? 'Too many emails at once; try again in a moment.' : 'Your Resend sending quota is used up.';
  } else if (res.status >= 500) {
    hint = 'Resend had a problem; try again shortly.';
  }
  throw new ResendError(`Resend didn’t send the email: ${msg}${hint ? ` ${hint}` : ''}`, res.status, body.name);
}
