/** TEST-ONLY fake OP3 API (https://op3.dev/api/docs): one known show. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOp3 {
  apiUrl: string;
  requests: { path: string; auth: string | undefined }[];
  /** podcast:guid values the fake knows (all map to `uuid`). */
  guids: Set<string>;
  /** Download records served by /downloads/show (kept sorted by time). */
  downloads: { time: string; countryCode: string | null }[];
  /** Rows for /queries/episode-download-counts (defaults to two sample episodes). */
  episodes: Record<string, unknown>[];
  /** Answer 500 to the next `count` requests whose path starts with `path`. */
  fail: { path: string; count: number } | null;
  /** Wait this long before answering paths starting with the key. */
  delays: Map<string, number>;
  close(): Promise<void>;
}

export async function startFakeOp3(opts: { token: string; uuid: string; title?: string }): Promise<FakeOp3> {
  const requests: FakeOp3['requests'] = [];
  const guids = new Set<string>();
  const downloads: FakeOp3['downloads'] = [];
  const episodes: FakeOp3['episodes'] = [
    { itemGuid: 'ep-2', title: 'Tomatoes', pubdate: '2026-10-14T10:00:00.000Z', downloads1: 90, downloads3: 140, downloads7: 180, downloads30: 220, downloadsAll: 220 },
    { itemGuid: 'ep-1', title: 'Soil', pubdate: '2026-09-01T10:00:00.000Z', downloads1: 70, downloads3: 110, downloads7: 150, downloads30: 300, downloadsAll: 410 },
  ];
  const state = { fail: null as FakeOp3['fail'], delays: new Map<string, number>() };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    requests.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    const delay = [...state.delays].find(([k]) => url.pathname.startsWith(k))?.[1];
    if (delay) {
      const t = setTimeout(() => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'), delay);
      res.on('close', () => clearTimeout(t));
      return;
    }
    if (state.fail && state.fail.count > 0 && url.pathname.startsWith(state.fail.path)) {
      state.fail.count--;
      return res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Internal error"}');
    }
    const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${opts.token}`) return json(401, { error: 'Unauthorized' });
    const m = /^\/api\/1\/shows\/(.+)$/.exec(url.pathname);
    if (m) {
      const key = decodeURIComponent(m[1]!);
      return guids.has(key) || key === opts.uuid
        ? json(200, { showUuid: opts.uuid, title: opts.title ?? 'Garden Talk', podcastGuid: [...guids][0], statsPageUrl: `https://op3.dev/show/${opts.uuid}` })
        : json(404, { error: 'not found' });
    }
    if (url.pathname === '/api/1/queries/show-download-counts') {
      return json(200, { asof: '2026-10-21T20:00:00.000Z', showDownloadCounts: { [url.searchParams.get('showUuid')!]: { monthlyDownloads: 1234, days: '1'.repeat(30), weeklyAvgDownloads: 300, weeklyDownloads: [250, 280, 320, 350], numWeeks: 4 } } });
    }
    if (url.pathname === '/api/1/queries/episode-download-counts') {
      return json(200, { showUuid: opts.uuid, episodes });
    }
    if (url.pathname === `/api/1/downloads/show/${opts.uuid}`) {
      const q = url.searchParams;
      const limit = Number(q.get('limit') ?? 100);
      const rel = (v: string | null) => (v ? Date.parse(v) : null);
      const start = rel(q.get('start')), after = rel(q.get('startAfter')), end = rel(q.get('end'));
      const all = downloads.filter((d) => {
        const t = Date.parse(d.time);
        return (start === null || t >= start) && (after === null || t > after) && (end === null || t < end);
      });
      const offset = q.get('continuationToken') ? Number(q.get('continuationToken')) : 0;
      const rows = all.slice(offset, offset + limit).map((d) => ({ time: d.time, showUuid: opts.uuid, countryCode: d.countryCode, agentName: 'Overcast' }));
      const more = offset + limit < all.length;
      return json(200, { rows, count: rows.length, queryTime: 1, ...(more ? { continuationToken: String(offset + limit) } : {}) });
    }
    if (url.pathname === '/api/1/queries/top-apps-for-show') return json(200, { showUuid: opts.uuid, appDownloads: { Overcast: 120, 'Apple Podcasts': 500, Spotify: 300 } });
    json(404, { error: 'unknown' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/1`,
    requests,
    guids,
    downloads,
    episodes,
    get fail() { return state.fail; },
    set fail(v) { state.fail = v; },
    delays: state.delays,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
