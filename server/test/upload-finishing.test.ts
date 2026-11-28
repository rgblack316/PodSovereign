import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createApp } from '../src/http/app.js';
import { resumeUploads, testHooks } from '../src/media/uploads.js';
import { setupDb, tempDir, testConfig } from './support/env.js';
import { mp3 } from './support/media-samples.js';

let db: Db;
let server: http.Server;
let base: string;
let mediaDir: string;
let config: ReturnType<typeof testConfig>;
let cookie = '';
let show: string;

async function api(method: string, p: string, body?: unknown) {
  const raw = body instanceof Buffer;
  const res = await fetch(base + p, {
    method,
    headers: { ...(method !== 'GET' ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: method === 'GET' ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body ?? {}),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

/** Everything but the final "complete" call. */
async function sendAll(name: string) {
  const body = mp3(300);
  const r = await api('POST', `/api/podcasts/${show}/uploads`, { filename: name, size: body.length });
  const id: string = r.json.upload.id;
  assert.equal((await api('PUT', `/api/podcasts/${show}/uploads/${id}?offset=0`, body)).status, 200);
  return { id, body };
}

async function until(id: string, want: string) {
  for (let i = 0; i < 100; i++) {
    const r = await api('GET', `/api/podcasts/${show}/uploads/${id}`);
    if (r.json.upload.status === want) return r.json.upload;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`upload never reached ${want}`);
}

before(async () => {
  db = await setupDb('feedhost_upload_finishing_test');
  mediaDir = await tempDir('upload-finishing-media');
  config = testConfig({ mediaDir, publicBaseUrl: 'http://feeds.mine.test', mediaBaseUrl: 'http://feeds.mine.test' });
  server = http.createServer(createApp({ db, config }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await api('POST', '/api/auth/register', { email: 'a@example.com', password: 'correct horse battery' })).status, 201);
  show = (await api('POST', '/api/podcasts', { title: 'Slow Show', slug: 'slow-show' })).json.podcast.id;
});

after(async () => {
  testHooks.beforeStore = undefined;
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

describe('finishing a big upload in the background', () => {
  test('a slow file gets a 202, a second complete joins the same work, and polling ends with the media', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let stores = 0;
    testHooks.beforeStore = async () => { stores++; await gate; };
    config.uploadWaitMs = 20;
    const { id, body } = await sendAll('slow.mp3');

    const first = await api('POST', `/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(first.status, 202, first.text);
    assert.equal(first.json.upload.status, 'finishing');
    const second = await api('POST', `/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(second.status, 202);
    assert.equal((await api('GET', `/api/podcasts/${show}/uploads/${id}`)).json.upload.status, 'finishing');
    assert.equal((await api('DELETE', `/api/podcasts/${show}/uploads/${id}`)).status, 409, 'can’t cancel once it is being stored');

    release();
    const done = await until(id, 'done');
    assert.equal(done.media.bytes, body.length);
    assert.equal(stores, 1, 'stored once');
    const again = await api('POST', `/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(again.status, 201, 'asking again after it finished returns the media');
    assert.equal(again.json.media.id, done.media.id);
  });

  test('a fast file still answers straight away with the media', async () => {
    testHooks.beforeStore = undefined;
    config.uploadWaitMs = 25_000;
    const { id } = await sendAll('fast.mp3');
    const r = await api('POST', `/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.media.kind, 'audio');
  });

  test('a failure is recorded with its reason, and completing again retries it', async () => {
    testHooks.beforeStore = async () => { throw new Error('Storage said no'); };
    config.uploadWaitMs = 25_000;
    const { id } = await sendAll('flaky.mp3');
    const bad = await api('POST', `/api/podcasts/${show}/uploads/${id}/complete`);
    assert.ok(bad.status >= 400, bad.text);
    const failed = await until(id, 'failed');
    assert.match(failed.error, /Storage said no/);

    testHooks.beforeStore = undefined;
    const retry = await api('POST', `/api/podcasts/${show}/uploads/${id}/complete`);
    assert.equal(retry.status, 201, retry.text);
  });

  test('after a restart, files being stored are picked up again, or marked failed if the bytes are gone', async () => {
    testHooks.beforeStore = undefined;
    const kept = await sendAll('kept.mp3');
    const lost = await sendAll('lost.mp3');
    await db.query(`UPDATE uploads SET status = 'finishing' WHERE id IN ($1, $2)`, [kept.id, lost.id]);
    await rm(path.join(path.resolve(mediaDir), '.uploads', `${lost.id}.part`));
    await resumeUploads(db, config);
    assert.ok((await until(kept.id, 'done')).media);
    const gone = await until(lost.id, 'failed');
    assert.match(gone.error, /lost when the server restarted/);
  });
});
