/** TEST-ONLY fake Cloudflare API: zone lookup and cache purges. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCloudflare {
  url: string;
  /** Every purge request's list of addresses, in order. */
  purges: string[][];
  close(): Promise<void>;
}

export async function startFakeCloudflare(opts: { zoneId: string; token: string; zone: string }): Promise<FakeCloudflare> {
  const purges: string[][] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      if (req.headers.authorization !== `Bearer ${opts.token}`) return send(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
      if (req.method === 'GET' && req.url === `/zones/${opts.zoneId}`) return send(200, { success: true, result: { id: opts.zoneId, name: opts.zone } });
      if (req.method === 'POST' && req.url === `/zones/${opts.zoneId}/purge_cache`) {
        purges.push(JSON.parse(body).files);
        return send(200, { success: true, result: { id: opts.zoneId } });
      }
      send(404, { success: false, errors: [{ code: 7003, message: 'Could not route' }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    purges,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
