/**
 * TEST-ONLY fake S3 and Bunny servers. The fake S3 server re-derives the
 * SigV4 signature from the raw incoming request with the known secret and
 * rejects mismatches (like real S3), and checks payload hashes.
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface FakeS3 {
  endpoint: string;
  publicUrl: string;
  objects: Map<string, { body: Buffer; type: string; acl?: string }>;
  requests: { method: string; url: string; acl?: string }[];
  /** Keys whose upload should fail with 500. */
  failKeys: Set<string>;
  multipartUploads: number;
  close(): Promise<void>;
}

export async function startFakeS3(opts: { bucket: string; accessKeyId: string; secret: string; region: string }): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; type: string; acl?: string }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer>; type: string }>();
  const requests: { method: string; url: string; acl?: string }[] = [];
  const failKeys = new Set<string>();
  const state = { multipartUploads: 0 };

  const xmlError = (res: http.ServerResponse, status: number, code: string, msg: string) =>
    res.writeHead(status, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${msg}</Message></Error>`);

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, 'http://x');
      requests.push({ method: req.method!, url: req.url!, ...(req.headers['x-amz-acl'] ? { acl: String(req.headers['x-amz-acl']) } : {}) });

      // Public "CDN" side: /public/<key>
      if (url.pathname.startsWith('/public/')) {
        const o = objects.get(decodeURIComponent(url.pathname.slice('/public/'.length)));
        if (!o) return res.writeHead(404).end('nope');
        return res.writeHead(200, { 'Content-Type': o.type }).end(o.body);
      }

      // --- verify SigV4 ---
      const auth = req.headers.authorization ?? '';
      const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(auth);
      if (!m) return xmlError(res, 403, 'AccessDenied', 'Missing or malformed Authorization');
      const [, keyId, date, region, signed, sig] = m;
      if (keyId !== opts.accessKeyId) return xmlError(res, 403, 'InvalidAccessKeyId', 'Unknown key');
      if (region !== opts.region) return xmlError(res, 400, 'AuthorizationHeaderMalformed', 'Wrong region');
      const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
      if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha(body)) return xmlError(res, 400, 'XAmzContentSHA256Mismatch', 'Payload hash mismatch');
      const rawPath = req.url!.split('?')[0]!;
      const rawQuery = req.url!.includes('?') ? req.url!.slice(req.url!.indexOf('?') + 1) : '';
      const query = rawQuery
        .split('&')
        .filter(Boolean)
        .map((p) => {
          const [k, v = ''] = p.split('=');
          return [enc(decodeURIComponent(k!)), enc(decodeURIComponent(v))] as const;
        })
        .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const names = signed!.split(';');
      const canonicalHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim()}\n`).join('');
      const canonical = [req.method, rawPath, query, canonicalHeaders, signed, payloadHash].join('\n');
      const scope = `${date}/${region}/s3/aws4_request`;
      const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha(canonical)].join('\n');
      const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secret}`, date!), region!), 's3'), 'aws4_request');
      if (createHmac('sha256', kSigning).update(sts).digest('hex') !== sig) {
        return xmlError(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match');
      }
      if (!names.includes('host') || !names.includes('x-amz-date')) return xmlError(res, 403, 'AccessDenied', 'host and x-amz-date must be signed');

      // --- path-style routing: /<bucket>/<key> ---
      const parts = rawPath.split('/').slice(1);
      if (decodeURIComponent(parts[0] ?? '') !== opts.bucket) return xmlError(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
      const key = parts.slice(1).map(decodeURIComponent).join('/');
      const q = url.searchParams;

      if (req.method === 'GET' && !key && q.get('list-type') === '2') {
        const prefix = q.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const max = Number(q.get('max-keys') ?? 1000);
        const start = q.get('continuation-token') ? Number(q.get('continuation-token')) : 0;
        const page = keys.slice(start, start + Math.min(max, 2)); // tiny pages to exercise pagination
        const more = start + page.length < keys.length;
        return res.writeHead(200, { 'Content-Type': 'application/xml' }).end(
          `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}` +
            `<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>` : ''}</ListBucketResult>`,
        );
      }
      if (req.method === 'POST' && q.has('uploads')) {
        const id = `up${uploads.size + 1}`;
        uploads.set(id, { key, parts: new Map(), type: String(req.headers['content-type'] ?? '') });
        state.multipartUploads++;
        return res.writeHead(200).end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        const u = uploads.get(q.get('uploadId')!);
        if (!u) return xmlError(res, 404, 'NoSuchUpload', 'no upload');
        u.parts.set(Number(q.get('partNumber')), body);
        return res.writeHead(200, { ETag: `"${sha(body).slice(0, 32)}"` }).end();
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        const u = uploads.get(q.get('uploadId')!);
        if (!u) return xmlError(res, 404, 'NoSuchUpload', 'no upload');
        const order = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((x) => Number(x[1]));
        objects.set(u.key, { body: Buffer.concat(order.map((n) => u.parts.get(n)!)), type: u.type });
        uploads.delete(q.get('uploadId')!);
        return res.writeHead(200).end('<CompleteMultipartUploadResult/>');
      }
      if (req.method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId')!);
        return res.writeHead(204).end();
      }
      if (req.method === 'PUT') {
        if (failKeys.has(key)) return xmlError(res, 500, 'InternalError', 'Simulated failure');
        objects.set(key, { body, type: String(req.headers['content-type'] ?? ''), acl: req.headers['x-amz-acl'] as string | undefined });
        return res.writeHead(200, { ETag: '"x"' }).end();
      }
      if (req.method === 'GET') {
        const o = objects.get(key);
        if (!o) return xmlError(res, 404, 'NoSuchKey', 'The specified key does not exist.');
        return res.writeHead(200, { 'Content-Type': o.type }).end(o.body);
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      xmlError(res, 405, 'MethodNotAllowed', 'nope');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint: base,
    publicUrl: `${base}/public`,
    objects,
    requests,
    failKeys,
    get multipartUploads() {
      return state.multipartUploads;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface FakeBunny {
  hostname: string;
  publicUrl: string;
  files: Map<string, { body: Buffer; type: string }>;
  close(): Promise<void>;
}

export async function startFakeBunny(opts: { zone: string; password: string }): Promise<FakeBunny> {
  const files = new Map<string, { body: Buffer; type: string }>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, 'http://x');
      if (url.pathname.startsWith('/pull/')) {
        const f = files.get(decodeURIComponent(url.pathname.slice('/pull/'.length)));
        return f ? res.writeHead(200, { 'Content-Type': f.type }).end(f.body) : res.writeHead(404).end();
      }
      if (req.headers.accesskey !== opts.password) return res.writeHead(401).end(JSON.stringify({ HttpCode: 401, Message: 'Unauthorized' }));
      const segs = url.pathname.split('/').slice(1).map(decodeURIComponent);
      if (segs[0] !== opts.zone) return res.writeHead(404).end(JSON.stringify({ HttpCode: 404, Message: 'Storage zone not found' }));
      const key = segs.slice(1).join('/');
      if (req.method === 'PUT') {
        const want = req.headers.checksum;
        if (want && want !== createHash('sha256').update(body).digest('hex').toUpperCase()) {
          return res.writeHead(400).end(JSON.stringify({ HttpCode: 400, Message: 'Checksum mismatch' }));
        }
        files.set(key, { body, type: String(req.headers['content-type'] ?? '') });
        return res.writeHead(201).end(JSON.stringify({ HttpCode: 201, Message: 'File uploaded.' }));
      }
      if (req.method === 'GET' && (key === '' || key.endsWith('/'))) {
        // Directory listing: the files and folders directly inside.
        const names = new Map<string, boolean>();
        for (const k of files.keys()) {
          if (!k.startsWith(key)) continue;
          const rest = k.slice(key.length);
          const i = rest.indexOf('/');
          names.set(i < 0 ? rest : rest.slice(0, i), i >= 0);
        }
        return res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify([...names].map(([ObjectName, IsDirectory]) => ({ ObjectName, IsDirectory, Path: `/${opts.zone}/${key}` }))));
      }
      if (req.method === 'GET') {
        const f = files.get(key);
        return f ? res.writeHead(200).end(f.body) : res.writeHead(404).end(JSON.stringify({ HttpCode: 404, Message: 'Object Not Found' }));
      }
      if (req.method === 'DELETE') {
        if (!key) return res.writeHead(400).end(JSON.stringify({ HttpCode: 400, Message: 'Root delete blocked' }));
        if (key.endsWith('/')) for (const k of [...files.keys()]) if (k.startsWith(key)) files.delete(k);
        files.delete(key);
        return res.writeHead(200).end(JSON.stringify({ HttpCode: 200, Message: 'File deleted successfuly.' }));
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { hostname: base, publicUrl: `${base}/pull`, files, close: () => new Promise((r) => server.close(() => r())) };
}
