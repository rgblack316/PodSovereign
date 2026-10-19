/**
 * Outbound HTTP for imports. Users supply the feed URL, so every request is
 * guarded against SSRF: hostnames are resolved and connections to private,
 * loopback, link-local and metadata addresses are refused — checked at
 * connect time (inside the DNS lookup hook) so DNS rebinding can't slip past,
 * and again on every redirect hop.
 */
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class FetchError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
  }
}

export interface GetOptions {
  allowPrivate: boolean;
  maxBytes: number;
  /** Idle socket timeout. */
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
}

const USER_AGENT = 'FeedHost/0.1 (+self-hosted podcast feed import)';

const blocked = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, bits, 'ipv4');
for (const [net6, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const)
  blocked.addSubnet(net6, bits, 'ipv6');

export function isPrivateAddress(addr: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const fam = net.isIP(addr);
  if (fam === 4) return blocked.check(addr, 'ipv4');
  if (fam === 6) return blocked.check(addr, 'ipv6');
  return true;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err, '');
      const list = addrs as dns.LookupAddress[];
      const bad = allowPrivate ? undefined : list.find((a) => isPrivateAddress(a.address));
      if (bad) return cb(new FetchError(`Refusing to connect to private address ${bad.address} (${hostname})`, false), '');
      if (!list.length) return cb(new FetchError(`No addresses for ${hostname}`, true), '');
      if (options.all) cb(null, list);
      else cb(null, list[0]!.address, list[0]!.family);
    });
  };
}

interface Opened {
  res: http.IncomingMessage;
  finalUrl: string;
}

/** One guarded GET, no redirect following. */
async function requestOnce(url: string, opts: GetOptions): Promise<{ res: http.IncomingMessage; u: URL }> {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError(`Unsupported URL scheme ${u.protocol}`, false);
  if (u.username || u.password) throw new FetchError('URLs with credentials are not allowed', false);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) {
    throw new FetchError(`Refusing to connect to private address ${host}`, false);
  }
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      u,
      {
        headers: { 'User-Agent': USER_AGENT, Accept: opts.accept ?? '*/*', 'Accept-Encoding': 'identity' },
        lookup: guardedLookup(opts.allowPrivate) as unknown as typeof dns.lookup,
        timeout: opts.timeoutMs ?? 30_000,
      },
      resolve,
    );
    req.on('timeout', () => req.destroy(new FetchError(`Timed out fetching ${u.host}`, true)));
    req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError(`${e.message} (${u.host})`, true)));
  });
  return { res, u };
}

export interface RedirectHop {
  url: string;
  status: number;
}

/**
 * Follow redirects by hand and report every hop (for the 301 check).
 * `stopAt` ends the trace without requesting a URL (e.g. our own feed, which
 * would otherwise be fetched back through the tunnel).
 */
export async function traceRedirects(url: string, opts: GetOptions, stopAt?: (url: string) => boolean): Promise<RedirectHop[]> {
  const hops: RedirectHop[] = [];
  let current = url;
  for (let i = 0; i <= (opts.maxRedirects ?? 5); i++) {
    if (i > 0 && stopAt?.(current)) {
      hops.push({ url: current, status: 200 });
      return hops;
    }
    const { res, u } = await requestOnce(current, opts);
    res.resume();
    const status = res.statusCode ?? 0;
    hops.push({ url: current, status });
    const loc = res.headers.location;
    if (![301, 302, 303, 307, 308].includes(status) || !loc) return hops;
    current = new URL(loc, u).toString();
  }
  hops.push({ url: current, status: 0 });
  return hops;
}

async function open(url: string, opts: GetOptions): Promise<Opened> {
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const { res, u } = await requestOnce(current, opts);

    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      res.resume();
      const loc = res.headers.location;
      if (!loc) throw new FetchError(`Redirect without Location from ${u.host}`, false, status);
      current = new URL(loc, u).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new FetchError(`HTTP ${status} from ${u.host}`, status >= 500 || status === 429 || status === 408, status);
    }
    const len = Number(res.headers['content-length'] ?? 0);
    if (len > opts.maxBytes) {
      res.destroy();
      throw new FetchError(`File is ${len} bytes; limit is ${opts.maxBytes}`, false);
    }
    return { res, finalUrl: current };
  }
  throw new FetchError(`Too many redirects from ${url}`, false);
}

function limiter(max: number) {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(new FetchError(`Download exceeded limit of ${max} bytes`, false));
      else cb(null, chunk);
    },
  });
}

/** Fetch a feed as text, honouring the XML declaration's encoding. */
export async function fetchFeedText(url: string, opts: GetOptions): Promise<{ text: string; finalUrl: string }> {
  const { res, finalUrl } = await open(url, { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1', ...opts });
  const chunks: Buffer[] = [];
  await pipeline(res, limiter(opts.maxBytes), async function* (src) {
    for await (const c of src) chunks.push(c as Buffer);
  });
  return { text: decodeXml(Buffer.concat(chunks), res.headers['content-type']), finalUrl };
}

export function decodeXml(buf: Buffer, contentType?: string): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const decl = /<\?xml[^>]*encoding=["']([\w.:-]+)["']/i.exec(buf.subarray(0, 300).toString('latin1'))?.[1];
  const header = /charset=["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  for (const label of [decl, header, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      /* unknown label — try the next */
    }
  }
  return buf.toString('utf8');
}

export interface Downloaded {
  bytes: number;
  sha256: string;
  mimeType: string | null;
  finalUrl: string;
}

/** Stream a file to `dest` (via a temp file, renamed on success). */
export async function downloadToFile(url: string, dest: string, opts: GetOptions): Promise<Downloaded> {
  const { res, finalUrl } = await open(url, opts);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _e, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res, limiter(opts.maxBytes), tap, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e instanceof FetchError ? e : new FetchError(`Download failed: ${(e as Error).message}`, true);
  }
  const mimeType = res.headers['content-type']?.split(';')[0]?.trim() || null;
  return { bytes, sha256: hash.digest('hex'), mimeType, finalUrl };
}

/** Retry retryable failures with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 1000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof FetchError ? e.retryable : true;
      if (!retryable || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, baseMs * 2 ** (i - 1)));
    }
  }
}
