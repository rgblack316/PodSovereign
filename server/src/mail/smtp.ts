/**
 * Minimal SMTP client for sending plain-text email (verification codes, test
 * messages). Supports implicit TLS (port 465), STARTTLS (587) and plain
 * connections, with AUTH PLAIN or LOGIN. No dependencies.
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user?: string | null;
  password?: string | null;
  /** e.g. "Johns Creek Studios <podcasts@johnscreekstudios.com>" */
  from: string;
  /** Tests only: accept self-signed certificates. */
  insecureTls?: boolean;
  timeoutMs?: number;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  attachments?: Attachment[];
}

export class SmtpError extends Error {}

/** Reads SMTP replies (possibly multi-line: "250-…" then "250 …"). */
class Conn {
  private buf = '';
  private waiting: ((r: { code: number; text: string }) => void) | null = null;
  private lines: string[] = [];
  private closedError: Error | null = null;

  constructor(public sock: net.Socket | tls.TLSSocket, timeoutMs: number) {
    this.attach(sock);
    sock.setTimeout(timeoutMs, () => sock.destroy(new SmtpError('The mail server stopped responding')));
  }

  attach(sock: net.Socket | tls.TLSSocket) {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const all = this.lines;
          this.lines = [];
          const w = this.waiting;
          this.waiting = null;
          w?.({ code: Number(line.slice(0, 3)), text: all.map((l) => l.slice(4)).join('\n') });
        }
      }
    });
    sock.on('error', (e) => {
      this.closedError = e;
      const w = this.waiting;
      this.waiting = null;
      if (w) w({ code: 0, text: e.message });
    });
  }

  reply(): Promise<{ code: number; text: string }> {
    if (this.closedError) return Promise.resolve({ code: 0, text: this.closedError.message });
    return new Promise((res) => (this.waiting = res));
  }

  async cmd(line: string, expect: number[], label = line.split(' ')[0]!): Promise<string> {
    this.sock.write(`${line}\r\n`);
    const r = await this.reply();
    if (!expect.includes(r.code)) {
      throw new SmtpError(r.code === 0 ? `Lost connection to the mail server: ${r.text}` : `Mail server rejected ${label}: ${r.code} ${r.text}`);
    }
    return r.text;
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** RFC 2047 encoded-word for non-ASCII header values. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`;
}

/** The bare address from "Name <a@b>" or "a@b". */
export function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();
}

function formatFrom(from: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m || !m[1]) return addressOf(from);
  return `${encodeHeader(m[1].replace(/^"|"$/g, ''))} <${m[2]}>`;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export async function sendMail(cfg: SmtpConfig, mail: Mail): Promise<void> {
  const fromAddr = addressOf(cfg.from);
  if (!EMAIL_RE.test(fromAddr)) throw new SmtpError('The “From” address isn’t a valid email address');
  if (!EMAIL_RE.test(mail.to)) throw new SmtpError('The recipient address isn’t valid');
  if (/[\r\n]/.test(mail.to + mail.subject + cfg.from)) throw new SmtpError('Invalid characters in the message headers');

  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const tlsOpts = { servername: cfg.host, rejectUnauthorized: !cfg.insecureTls };
  const raw = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
    const s = cfg.security === 'tls'
      ? tls.connect({ host: cfg.host, port: cfg.port, ...tlsOpts }, () => resolve(s))
      : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', (e) => reject(new SmtpError(`Couldn't connect to ${cfg.host}:${cfg.port}: ${e.message}`)));
    s.setTimeout(timeoutMs, () => s.destroy(new Error('timed out')));
  });

  const c = new Conn(raw, timeoutMs);
  const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  try {
    const greet = await c.reply();
    if (greet.code !== 220) throw new SmtpError(`Unexpected greeting from the mail server: ${greet.code} ${greet.text}`);
    let caps = await c.cmd(`EHLO ${helo}`, [250]);

    if (cfg.security === 'starttls') {
      if (!/^STARTTLS/im.test(caps)) throw new SmtpError('The mail server doesn’t offer STARTTLS on this port');
      await c.cmd('STARTTLS', [220]);
      const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
        raw.removeAllListeners('data');
        const t = tls.connect({ socket: raw as net.Socket, ...tlsOpts }, () => resolve(t));
        t.once('error', (e) => reject(new SmtpError(`Secure connection failed: ${e.message}`)));
      });
      c.attach(secured);
      caps = await c.cmd(`EHLO ${helo}`, [250]);
    }

    if (cfg.user) {
      const authLine = /^AUTH[ =](.*)$/im.exec(caps)?.[1]?.toUpperCase() ?? '';
      if (authLine.includes('PLAIN')) {
        await c.cmd(`AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password ?? ''}`)}`, [235], 'the username or password');
      } else if (authLine.includes('LOGIN')) {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(b64(cfg.user), [334], 'the username');
        await c.cmd(b64(cfg.password ?? ''), [235], 'the username or password');
      } else {
        throw new SmtpError('The mail server doesn’t accept password sign-in on this connection (try STARTTLS or TLS)');
      }
    }

    await c.cmd(`MAIL FROM:<${fromAddr}>`, [250], 'the sender address');
    await c.cmd(`RCPT TO:<${mail.to}>`, [250, 251], 'the recipient address');
    await c.cmd('DATA', [354]);
    const domain = fromAddr.split('@')[1];
    const wrap = (b: Buffer) => b.toString('base64').replace(/.{76}/g, '$&\r\n');
    const body = wrap(Buffer.from(mail.text.replace(/\r?\n/g, '\r\n'), 'utf8'));
    const headers = [
      `From: ${formatFrom(cfg.from)}`,
      `To: <${mail.to}>`,
      `Subject: ${encodeHeader(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
      'MIME-Version: 1.0',
    ];
    let message: string;
    if (!mail.attachments?.length) {
      message = [...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n');
    } else {
      const boundary = `ps-${randomBytes(12).toString('hex')}`;
      const parts = [
        `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
        ...mail.attachments.flatMap((a) => {
          const name = a.filename.replace(/["\r\n\\]/g, '_');
          return [`--${boundary}`, `Content-Type: ${a.contentType}; name="${name}"`, 'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${name}"`, '', wrap(a.content)];
        }),
        `--${boundary}--`,
      ];
      message = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
    }
    // base64 never starts a line with ".", so no dot-stuffing is needed.
    await c.cmd(`${message}\r\n.`, [250], 'the message');
    await c.cmd('QUIT', [221]).catch(() => {});
  } finally {
    c.sock.destroy();
  }
}
