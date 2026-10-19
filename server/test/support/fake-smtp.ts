/** TEST-ONLY SMTP server: plain or STARTTLS, AUTH PLAIN/LOGIN, records messages. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

export interface Received {
  from: string;
  to: string[];
  data: string;
  /** Decoded text body. */
  text: string;
  subject: string;
}

export interface FakeSmtp {
  port: number;
  messages: Received[];
  close(): Promise<void>;
}

function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'smtp-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  return { key: readFileSync(`${dir}/k.pem`, 'utf8'), cert: readFileSync(`${dir}/c.pem`, 'utf8') };
}

const decodeHeader = (v: string) =>
  v.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b: string) => Buffer.from(b, 'base64').toString('utf8'));

export async function startFakeSmtp(opts: { user?: string; password?: string; starttls?: boolean } = {}): Promise<FakeSmtp> {
  const messages: Received[] = [];
  const creds = opts.starttls ? selfSigned() : null;

  const server = net.createServer((raw) => {
    let sock: net.Socket | tls.TLSSocket = raw;
    let buf = '';
    let mode: 'cmd' | 'data' | 'login-user' | 'login-pass' = 'cmd';
    let authed = !opts.user;
    let secure = false;
    let loginUser = '';
    let msg: { from: string; to: string[] } = { from: '', to: [] };
    let data = '';
    const send = (s: string) => sock.write(`${s}\r\n`);

    const onLine = (line: string) => {
      if (mode === 'data') {
        if (line === '.') {
          mode = 'cmd';
          const [head, ...bodyParts] = data.split('\r\n\r\n');
          const body = bodyParts.join('\r\n\r\n');
          const subject = decodeHeader(/^Subject: (.*)$/m.exec(head ?? '')?.[1] ?? '');
          const text = /Content-Transfer-Encoding: base64/i.test(head ?? '') ? Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') : body;
          messages.push({ ...msg, data, subject, text });
          data = '';
          return send('250 OK queued');
        }
        data += (data ? '\r\n' : '') + line;
        return;
      }
      if (mode === 'login-user') {
        loginUser = Buffer.from(line, 'base64').toString();
        mode = 'login-pass';
        return send('334 UGFzc3dvcmQ6');
      }
      if (mode === 'login-pass') {
        mode = 'cmd';
        authed = loginUser === opts.user && Buffer.from(line, 'base64').toString() === opts.password;
        return send(authed ? '235 Authenticated' : '535 Authentication failed');
      }
      const [verb = '', ...rest] = line.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': {
          const caps = ['250-fake.smtp hello'];
          if (opts.starttls && !secure) caps.push('250-STARTTLS');
          if (opts.user && (secure || !opts.starttls)) caps.push('250-AUTH PLAIN LOGIN');
          caps.push('250 8BITMIME');
          return sock.write(caps.join('\r\n') + '\r\n');
        }
        case 'STARTTLS': {
          send('220 Go ahead');
          raw.removeAllListeners('data');
          const t = new tls.TLSSocket(raw, { isServer: true, key: creds!.key, cert: creds!.cert });
          sock = t;
          secure = true;
          t.setEncoding('utf8');
          t.on('data', onData);
          return;
        }
        case 'AUTH': {
          const [mech, initial] = arg.split(' ');
          if (mech === 'PLAIN') {
            const [, u, p] = Buffer.from(initial ?? '', 'base64').toString().split('\0');
            authed = u === opts.user && p === opts.password;
            return send(authed ? '235 Authenticated' : '535 Authentication failed');
          }
          if (mech === 'LOGIN') {
            mode = 'login-user';
            return send('334 VXNlcm5hbWU6');
          }
          return send('504 Unknown mechanism');
        }
        case 'MAIL':
          if (!authed) return send('530 Authentication required');
          msg = { from: /<([^>]*)>/.exec(arg)?.[1] ?? '', to: [] };
          return send('250 OK');
        case 'RCPT':
          if (/nobody@/.test(arg)) return send('550 No such user');
          msg.to.push(/<([^>]*)>/.exec(arg)?.[1] ?? '');
          return send('250 OK');
        case 'DATA':
          mode = 'data';
          return send('354 End data with <CR><LF>.<CR><LF>');
        case 'QUIT':
          send('221 Bye');
          return sock.end();
        default:
          return send('502 Command not implemented');
      }
    };
    const onData = (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    raw.setEncoding('utf8');
    raw.on('data', onData);
    raw.on('error', () => {});
    send('220 fake.smtp ESMTP ready');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    messages,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
