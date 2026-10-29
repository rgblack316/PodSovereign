/**
 * Minimal S3 client (AWS Signature Version 4) for S3-compatible storage:
 * Cloudflare R2, Backblaze B2, Amazon S3, Wasabi, DigitalOcean Spaces, MinIO…
 * Implemented directly on node:https so there's no SDK dependency.
 * The signer is checked against AWS's published examples in the tests.
 */
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** true: https://endpoint/bucket/key   false: https://bucket.endpoint/key */
  pathStyle: boolean;
  /** Send x-amz-acl (e.g. public-read) on uploads — needed by DigitalOcean Spaces. */
  acl?: string | null;
  /** Files at least this big are uploaded in parts (default 64 MB). */
  multipartThreshold?: number;
  /** Minimum part size (default 16 MB; S3 requires at least 5 MB except the last part). */
  minPartSize?: number;
}

export class S3Error extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

const EMPTY_HASH = createHash('sha256').update('').digest('hex');
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const MIN_PART = 16 * 1024 * 1024;

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export function uriEncode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

export interface SignInput {
  method: string;
  host: string;
  path: string; // already-encoded canonical URI
  query?: Record<string, string>;
  headers: Record<string, string>; // lower-case names; must include x-amz-date, x-amz-content-sha256
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
}

/** Compute the Authorization header (exported for the test vectors). */
export function signV4(i: SignInput): { authorization: string; canonicalRequest: string; stringToSign: string } {
  const amzDate = i.headers['x-amz-date']!;
  const date = amzDate.slice(0, 8);
  const service = i.service ?? 's3';
  const headers: Record<string, string> = { ...i.headers, host: i.host };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = Object.entries(i.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [i.method, i.path, query, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${i.secretAccessKey}`, date);
  const kSigning = hmac(hmac(hmac(kDate, i.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    canonicalRequest,
    stringToSign,
  };
}

const xmlValue = (xml: string, tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
const xmlUnescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

type Body = Buffer | { file: string; start: number; length: number } | null;

export class S3Client {
  private base: URL;

  constructor(private cfg: S3Config) {
    this.base = new URL(cfg.endpoint.replace(/\/+$/, ''));
  }

  private target(key: string): { host: string; path: string } {
    const encKey = key ? `/${uriEncode(key, true)}` : '/';
    const basePath = this.base.pathname.replace(/\/+$/, '');
    if (this.cfg.pathStyle) {
      return { host: this.base.host, path: `${basePath}/${uriEncode(this.cfg.bucket)}${key ? encKey : ''}` || '/' };
    }
    return { host: `${this.cfg.bucket}.${this.base.host}`, path: `${basePath}${encKey}` };
  }

  private async request(
    method: string,
    key: string,
    opts: { query?: Record<string, string>; body?: Body; payloadHash?: string; headers?: Record<string, string>; toFile?: string } = {},
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    const { host, path } = this.target(key);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = opts.payloadHash ?? (Buffer.isBuffer(opts.body) ? sha256hex(opts.body) : EMPTY_HASH);
    const length = opts.body ? (Buffer.isBuffer(opts.body) ? opts.body.length : opts.body.length) : 0;
    const headers: Record<string, string> = {
      ...Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    };
    if (method === 'PUT' || method === 'POST') headers['content-length'] = String(length);
    const { authorization } = signV4({
      method,
      host,
      path,
      query: opts.query,
      headers,
      payloadHash,
      region: this.cfg.region,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
    });
    const qs = Object.entries(opts.query ?? {})
      .map(([k, v]) => (v === '' ? uriEncode(k) : `${uriEncode(k)}=${uriEncode(v)}`))
      .join('&');
    const mod = this.base.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          method,
          protocol: this.base.protocol,
          hostname: this.cfg.pathStyle ? this.base.hostname : `${this.cfg.bucket}.${this.base.hostname}`,
          port: this.base.port || undefined,
          path: qs ? `${path}?${qs}` : path,
          headers: { ...headers, host, authorization },
          timeout: 120_000,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (opts.toFile && status >= 200 && status < 300) {
            pipeline(res, createWriteStream(opts.toFile))
              .then(() => resolve({ status, headers: res.headers, body: Buffer.alloc(0) }))
              .catch(reject);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Timed out talking to ${host}`)));
      req.on('error', (e) => reject(new S3Error(`Couldn't reach ${host}: ${e.message}`, 0)));
      const body = opts.body;
      if (!body) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else {
        void (async () => {
          const fh = await open(body.file, 'r');
          try {
            const stream = fh.createReadStream({ start: body.start, end: body.start + body.length - 1, autoClose: false });
            await pipeline(stream, req);
          } catch (e) {
            req.destroy(e as Error);
          } finally {
            await fh.close();
          }
        })();
      }
    });
  }

  private fail(op: string, r: { status: number; body: Buffer }): never {
    const text = r.body.toString('utf8');
    const code = xmlValue(text, 'Code');
    const msg = xmlValue(text, 'Message');
    const hint =
      r.status === 403 && code === 'SignatureDoesNotMatch' ? ' (check the secret key and region)'
        : r.status === 403 ? ' (check the key has read and write access to this bucket)'
          : r.status === 404 && code === 'NoSuchBucket' ? ' (check the bucket name and endpoint)'
            : r.status === 301 || code === 'PermanentRedirect' ? ' (wrong region or endpoint for this bucket)'
              : '';
    throw new S3Error(`${op} failed: HTTP ${r.status}${code ? ` ${code}` : ''}${msg ? `: ${xmlUnescape(msg)}` : ''}${hint}`, r.status, code);
  }

  private uploadHeaders(contentType: string): Record<string, string> {
    const h: Record<string, string> = { 'content-type': contentType };
    if (this.cfg.acl) h['x-amz-acl'] = this.cfg.acl;
    return h;
  }

  /** Copy an object within the bucket, on the provider's side (CopyObject; up to 5 GB). */
  async copy(fromKey: string, toKey: string): Promise<void> {
    const r = await this.request('PUT', toKey, {
      body: Buffer.alloc(0),
      headers: { 'x-amz-copy-source': `/${uriEncode(this.cfg.bucket)}/${uriEncode(fromKey, true)}`, ...(this.cfg.acl ? { 'x-amz-acl': this.cfg.acl } : {}) },
    });
    // CopyObject can answer 200 with an error inside.
    if (r.status !== 200 || /<Error>/.test(r.body.toString('utf8'))) this.fail('Copy', r);
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    const r = await this.request('PUT', key, { body, headers: this.uploadHeaders(contentType) });
    if (r.status < 200 || r.status >= 300) this.fail('Upload', r);
  }

  /** Upload a local file; large files go up in parts. `sha256` (hex) avoids re-reading small files. */
  async putFile(key: string, file: string, size: number, contentType: string, sha256?: string): Promise<void> {
    if (size < (this.cfg.multipartThreshold ?? MULTIPART_THRESHOLD)) {
      const fh = await open(file, 'r');
      let buf: Buffer;
      try {
        buf = Buffer.alloc(size);
        if (size) await fh.read(buf, 0, size, 0);
      } finally {
        await fh.close();
      }
      const r = await this.request('PUT', key, { body: buf, payloadHash: sha256 ?? sha256hex(buf), headers: this.uploadHeaders(contentType) });
      if (r.status < 200 || r.status >= 300) this.fail('Upload', r);
      return;
    }
    await this.multipart(key, file, size, contentType);
  }

  private async multipart(key: string, file: string, size: number, contentType: string): Promise<void> {
    const init = await this.request('POST', key, { query: { uploads: '' }, body: Buffer.alloc(0), headers: this.uploadHeaders(contentType) });
    if (init.status !== 200) this.fail('Starting upload', init);
    const uploadId = xmlValue(init.body.toString('utf8'), 'UploadId');
    if (!uploadId) throw new S3Error('Storage did not return an upload ID', init.status);
    const partSize = Math.max(this.cfg.minPartSize ?? MIN_PART, Math.ceil(size / 9000));
    const etags: string[] = [];
    try {
      const fh = await open(file, 'r');
      try {
        for (let n = 1, start = 0; start < size; n++, start += partSize) {
          const len = Math.min(partSize, size - start);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, start);
          const r = await this.request('PUT', key, { query: { partNumber: String(n), uploadId }, body: buf });
          if (r.status !== 200) this.fail(`Uploading part ${n}`, r);
          etags.push(String(r.headers.etag ?? ''));
        }
      } finally {
        await fh.close();
      }
      const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const done = await this.request('POST', key, { query: { uploadId }, body: Buffer.from(xml), headers: { 'content-type': 'application/xml' } });
      if (done.status !== 200 || /<Error>/.test(done.body.toString('utf8'))) this.fail('Finishing upload', done);
    } catch (e) {
      await this.request('DELETE', key, { query: { uploadId } }).catch(() => {});
      throw e;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const r = await this.request('GET', key);
    if (r.status !== 200) this.fail('Download', r);
    return r.body;
  }

  async getToFile(key: string, dest: string): Promise<void> {
    const r = await this.request('GET', key, { toFile: dest });
    if (r.status !== 200) this.fail('Download', r);
  }

  async delete(key: string): Promise<void> {
    const r = await this.request('DELETE', key);
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) this.fail('Delete', r);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const r = await this.request('GET', '', { query });
      if (r.status !== 200) this.fail('Listing files', r);
      const xml = r.body.toString('utf8');
      for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(xmlUnescape(m[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlValue(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return keys;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (const k of keys) await this.delete(k);
    return keys.length;
  }
}
