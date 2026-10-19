import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError, type Ctx } from './router.js';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
};

/** Dashboard files, read once at startup. Only these exact names can be served. */
const FILES = new Map<string, { body: Buffer; type: string }>();
for (const f of readdirSync(WEB_DIR)) {
  const ext = f.split('.').pop() ?? '';
  if (TYPES[ext]) FILES.set(f, { body: readFileSync(WEB_DIR + f), type: TYPES[ext]! });
}

/**
 * Content Security Policy: only our own scripts and styles (plus Google Fonts);
 * images may come from anywhere over https since show art can be remote until copied.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export async function serveStatic(ctx: Ctx, name: string): Promise<void> {
  const f = FILES.get(name);
  if (!f) throw new HttpError(404, 'Not found');
  ctx.res.writeHead(200, {
    'Content-Type': f.type,
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=300',
  });
  ctx.res.end(ctx.req.method === 'HEAD' ? undefined : f.body);
}
