/** TEST-ONLY fake Auphonic API: presets, productions, status and downloads. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeProduction { uuid: string; request: any; status: number; status_string: string; error_message?: string; chapters?: any[]; shownotes?: any }

export interface FakeAuphonic {
  url: string;
  key: string;
  productions: FakeProduction[];
  /** Files served for a finished production (by ending). */
  outputs: Map<string, { body: Buffer; format: string; ending: string; filename: string }>;
  /** Mark a production done (or failed). */
  finish(uuid: string, opts?: { error?: string; chapters?: any[]; shownotes?: any }): void;
  close(): Promise<void>;
}

export async function startFakeAuphonic(key: string): Promise<FakeAuphonic> {
  const productions: FakeProduction[] = [];
  const outputs: FakeAuphonic['outputs'] = new Map();
  let base = '';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const json = (status: number, data: unknown, extra: Record<string, unknown> = {}) =>
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status_code: status, data, ...extra }));
      // Downloads authenticate with ?bearer_token=
      if (url.pathname.startsWith('/download/')) {
        if (url.searchParams.get('bearer_token') !== key) return res.writeHead(401).end();
        const f = outputs.get(url.pathname.split('/').pop()!);
        return f ? res.writeHead(200).end(f.body) : res.writeHead(404).end();
      }
      if (req.headers.authorization !== `bearer ${key}`) return json(401, null, { error_message: 'Unauthorized' });
      if (url.pathname === '/api/user.json') return json(200, { username: 'randy' });
      if (url.pathname === '/api/presets.json') return json(200, [{ uuid: 'preset-podcast', preset_name: 'Podcast -16 LUFS' }, { uuid: 'preset-mono', preset_name: 'Mono talk' }]);
      if (url.pathname === '/api/productions.json' && req.method === 'POST') {
        const request = JSON.parse(body);
        // Like the real API: only these endings are accepted (it refuses "webvtt" despite the docs).
        const ok: Record<string, string[]> = { subtitle: ['srt'], transcript: ['txt', 'html'], speech: ['json', 'xml'] };
        const bad = (request.output_files ?? []).find((f: any) => ok[f.format] && !ok[f.format]!.includes(f.ending));
        if (bad) return json(400, null, { error_message: '', form_errors: { ending: [`Select a valid ending choice. ${bad.ending} is not one of the available choices.`] } });
        const p: FakeProduction = { uuid: `prod${productions.length + 1}`, request, status: 4, status_string: 'Audio Processing' };
        productions.push(p);
        return json(200, { uuid: p.uuid, status: p.status, status_string: p.status_string });
      }
      const m = /^\/api\/production\/([^/]+)\.json$/.exec(url.pathname);
      if (m) {
        const p = productions.find((x) => x.uuid === m[1]);
        if (!p) return json(404, null, { error_message: 'not found' });
        const files = p.status === 3 ? [...outputs.values()].map((f) => ({ format: f.format, ending: f.ending, filename: f.filename, download_url: `${base}/download/${p.uuid}/${f.ending}` })) : [];
        return json(200, { uuid: p.uuid, status: p.status, status_string: p.status_string, error_message: p.error_message ?? '', output_files: files, chapters: p.chapters ?? [], ...(p.shownotes ? { shownotes: p.shownotes } : {}) });
      }
      json(404, null, { error_message: 'unknown' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    key,
    productions,
    outputs,
    finish(uuid, opts = {}) {
      const p = productions.find((x) => x.uuid === uuid)!;
      if (opts.error) Object.assign(p, { status: 2, status_string: 'Error', error_message: opts.error });
      else Object.assign(p, { status: 3, status_string: 'Done', chapters: opts.chapters ?? [], shownotes: opts.shownotes });
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
