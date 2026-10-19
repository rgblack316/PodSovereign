/** One way to send email, whichever service the admin chose in Site settings. */
import type { Config } from '../config.js';
import { ResendError, sendViaResend } from './resend.js';
import { sendMail, SmtpError, type Mail, type SmtpConfig } from './smtp.js';

export type MailSettings =
  | { provider: 'smtp'; smtp: SmtpConfig }
  | { provider: 'resend'; apiKey: string; from: string; apiUrl?: string };

export class MailError extends Error {}

export async function sendEmail(config: Config, mail: Mail): Promise<void> {
  const m = config.mail;
  if (!m) throw new MailError('Email isn’t set up on this site');
  try {
    if (m.provider === 'resend') await sendViaResend({ apiKey: m.apiKey, from: m.from, apiUrl: m.apiUrl }, mail);
    else await sendMail(m.smtp, mail);
  } catch (e) {
    if (e instanceof SmtpError || e instanceof ResendError) throw new MailError(e.message);
    throw e;
  }
}
