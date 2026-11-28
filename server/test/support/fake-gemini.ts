import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGemini {
  url: string;
  key: string;
  /** Texts the next generateContent calls answer with, in order; the last one repeats. */
  replies: string[];
  requests: Array<{ model: string; body: any }>;
  /** Make the next generateContent call fail with this status. */
  failNext: number | null;
  close: () => Promise<void>;
}

export async function startFakeGemini(key: string): Promise<FakeGemini> {
  const fake: FakeGemini = { url: '', key, replies: [], requests: [], failNext: null, close: () => new Promise<void>((r) => server.close(() => r())) };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers['x-goog-api-key'] !== key) return send(400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
      const m = /^\/v1beta\/models\/([^:/]+)(:generateContent)?$/.exec(req.url ?? '');
      if (!m) return send(404, { error: { message: 'not found' } });
      if (!m[2]) return m[1] === 'gemini-test' ? send(200, { name: `models/${m[1]}` }) : send(404, { error: { message: 'model not found' } });
      if (fake.failNext) {
        const s = fake.failNext;
        fake.failNext = null;
        return send(s, { error: { message: 'quota' } });
      }
      fake.requests.push({ model: m[1]!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const text = fake.replies.length > 1 ? fake.replies.shift()! : fake.replies[0] ?? '{"chapters":[]}';
      send(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
