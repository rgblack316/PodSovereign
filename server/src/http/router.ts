import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<void>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get = (p: string, h: Handler) => this.add('GET', p, h);
  post = (p: string, h: Handler) => this.add('POST', p, h);
  put = (p: string, h: Handler) => this.add('PUT', p, h);
  delete = (p: string, h: Handler) => this.add('DELETE', p, h);

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]!);
        } catch {
          params[k] = m[i + 1]!;
        }
      });
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(status === 204 ? undefined : data);
}

export async function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > maxBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(c as Buffer);
  }
  if (!n) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}
