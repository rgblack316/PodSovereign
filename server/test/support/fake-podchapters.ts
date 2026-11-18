/** TEST-ONLY fake PodChapters API: account, episodes, transcripts and AI chapters. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePodChapters {
  url: string;
  key: string;
  /** Episodes made there (by id), with the last transcript uploaded and the last generate request. */
  episodes: Map<string, { id: string; filename: string; request: any; transcript: string | null; generated: any[] }>;
  /** What the next generate call returns (seconds, as PodChapters sends them). */
  chapters: { start: number; title: string; url?: string | null; image_url?: string | null; toc?: boolean }[];
  /** Set to fail the next generate call with this API error. */
  failNext: { status: number; code: string; message: string; hint?: string } | null;
  close(): Promise<void>;
}

export async function startFakePodChapters(key: string): Promise<FakePodChapters> {
  const episodes: FakePodChapters['episodes'] = new Map();
  let made = 0;
  const fake: FakePodChapters = {
    url: '', key, episodes, chapters: [], failNext: null,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const send = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      const err = (status: number, code: string, message: string, hint?: string) => send(status, { error: { code, message, hint } });
      if (req.headers.authorization !== `Bearer ${key}`) return err(401, 'unauthorized', 'Missing, invalid, or revoked API key.');
      if (req.method === 'GET' && url.pathname === '/api/v1/account') {
        return send(200, { id: 'u1', name: 'Randy', email: null, plan: { slug: 'smart', name: 'Smart' }, credits: { total_remaining: 120.5 }, access: { admin: false, features: [], unavailable_tools: [] }, auth_method: 'api_key' });
      }
      if (url.pathname === '/api/v1/episodes' && req.method === 'POST') {
        const request = JSON.parse(body);
        if ([...episodes.values()].some((e) => e.filename === request.filename)) return err(409, 'conflict', 'That filename is already used.');
        const id = `pc${++made}`;
        episodes.set(id, { id, filename: request.filename, request, transcript: null, generated: [] });
        return send(201, { id, filename: request.filename });
      }
      if (url.pathname === '/api/v1/episodes' && req.method === 'GET') {
        const q = url.searchParams.get('search') ?? '';
        return send(200, { episodes: [...episodes.values()].filter((e) => e.filename.includes(q)).map((e) => ({ id: e.id, filename: e.filename })) });
      }
      const m = /^\/api\/v1\/episodes\/([^/]+)\/(transcript|chapters\/generate)$/.exec(url.pathname);
      if (m) {
        const e = episodes.get(m[1]!);
        if (!e) return err(404, 'not_found', 'The episode or item doesn’t exist or isn’t yours.');
        if (m[2] === 'transcript' && req.method === 'PUT') {
          e.transcript = JSON.parse(body).content;
          return send(200, { episode_id: e.id });
        }
        if (m[2] === 'chapters/generate' && req.method === 'POST') {
          if (fake.failNext) {
            const f = fake.failNext;
            fake.failNext = null;
            return err(f.status, f.code, f.message, f.hint);
          }
          if (!e.transcript) return err(409, 'conflict', 'This episode needs a transcript first.');
          const request = JSON.parse(body);
          e.generated.push(request);
          const chapters = fake.chapters.map((c) => ({ start: c.start, start_time: String(c.start), title: c.title, url: c.url ?? null, url_title: null, image_url: c.image_url ?? null, toc: c.toc ?? true, location: null, utm: null }));
          return send(201, { episode_id: e.id, version_id: 'v1', selected: true, credits_spent: 0.2, chapters });
        }
      }
      err(404, 'not_found', 'No such route');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
