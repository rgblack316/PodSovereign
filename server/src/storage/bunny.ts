/**
 * Bunny Storage HTTP API (https://docs.bunny.net/reference/storage-api).
 * Auth: AccessKey header = the storage zone's password (not the account API key).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

export interface BunnyConfig {
  /** Region hostname, e.g. storage.bunnycdn.com or ny.storage.bunnycdn.com (or http://… for tests). */
  hostname: string;
  zone: string;
  password: string;
}

export class BunnyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const encPath = (key: string) => key.split('/').map(encodeURIComponent).join('/');

export class BunnyClient {
  private base: URL;

  constructor(private cfg: BunnyConfig) {
    this.base = new URL(/^https?:\/\//.test(cfg.hostname) ? cfg.hostname : `https://${cfg.hostname}`);
  }

  private request(
    method: string,
    key: string,
    opts: { body?: Buffer | { file: string }; headers?: Record<string, string>; toFile?: string } = {},
  ): Promise<{ status: number; body: Buffer }> {
    const mod = this.base.protocol === 'http:' ? http : https;
    const path = `${this.base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(this.cfg.zone)}/${encPath(key)}`;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          method,
          protocol: this.base.protocol,
          hostname: this.base.hostname,
          port: this.base.port || undefined,
          path,
          headers: { AccessKey: this.cfg.password, ...opts.headers },
          timeout: 120_000,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (opts.toFile && status === 200) {
            pipeline(res, createWriteStream(opts.toFile)).then(() => resolve({ status, body: Buffer.alloc(0) }), reject);
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Timed out talking to ${this.base.host}`)));
      req.on('error', (e) => reject(new BunnyError(`Couldn't reach ${this.base.host}: ${e.message}`, 0)));
      const b = opts.body;
      if (!b) req.end();
      else if (Buffer.isBuffer(b)) req.end(b);
      else pipeline(createReadStream(b.file), req).catch((e) => req.destroy(e));
    });
  }

  private fail(op: string, r: { status: number; body: Buffer }): never {
    const hint = r.status === 401
      ? ' (check the storage zone password, and that the region matches the zone’s main region)'
      : r.status === 404 ? ' (check the storage zone name)' : '';
    let msg = '';
    try {
      msg = JSON.parse(r.body.toString('utf8'))?.Message ?? '';
    } catch {
      /* not JSON */
    }
    throw new BunnyError(`${op} failed: HTTP ${r.status}${msg ? `: ${msg}` : ''}${hint}`, r.status);
  }

  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    const checksum = createHash('sha256').update(body).digest('hex').toUpperCase();
    const r = await this.request('PUT', key, {
      body,
      headers: { 'Content-Type': contentType, Checksum: checksum, 'Content-Length': String(body.length) },
    });
    if (r.status !== 201) this.fail('Upload', r);
  }

  async putFile(key: string, file: string, size: number, contentType: string, sha256?: string): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': contentType, 'Content-Length': String(size) };
    if (sha256) headers.Checksum = sha256.toUpperCase();
    const r = await this.request('PUT', key, { body: { file }, headers });
    if (r.status !== 201) this.fail('Upload', r);
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
    if (r.status !== 200 && r.status !== 404) this.fail('Delete', r);
  }

  /** Keys under a prefix (files in the prefix's folder whose names start with it; not recursive). */
  async list(prefix: string): Promise<string[]> {
    const slash = prefix.lastIndexOf('/');
    const dir = slash >= 0 ? prefix.slice(0, slash + 1) : '';
    const r = await this.request('GET', dir);
    if (r.status === 404) return [];
    if (r.status !== 200) this.fail('Listing files', r);
    let items: { ObjectName?: string; IsDirectory?: boolean }[] = [];
    try {
      items = JSON.parse(r.body.toString('utf8'));
    } catch {
      throw new BunnyError('Listing files failed: unexpected response', r.status);
    }
    return items.filter((i) => !i.IsDirectory && i.ObjectName).map((i) => dir + i.ObjectName!).filter((k) => k.startsWith(prefix));
  }

  /** Deleting a directory path (trailing slash) removes it recursively. Never the zone root. */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix || prefix === '/') throw new BunnyError('Refusing to delete the whole storage zone', 0);
    await this.delete(prefix.endsWith('/') ? prefix : `${prefix}/`);
    return 1;
  }
}
