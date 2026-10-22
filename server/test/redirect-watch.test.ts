import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Db } from '../src/db/db.js';
import { createPodcast } from '../src/db/podcasts.js';
import { recheckDueRedirects, saveRedirectResult } from '../src/http/redirect-check.js';
import { createUser, setupDb, startOldHost, testConfig } from './support/env.js';

let db: Db;
let host: Awaited<ReturnType<typeof startOldHost>>;
const config = testConfig({ publicBaseUrl: 'http://feeds.mine.test' });
let show: string;
let unconfirmed: string;

before(async () => {
  db = await setupDb('podsovereign_redirect_watch_test');
  host = await startOldHost();
  const owner = await createUser(db, 'randy@example.com');
  show = await createPodcast(db, { ownerId: owner, slug: 'wvedtalk', sourceUrl: `${host.base}/feeds/wvedtalk.xml`, title: 'WVEdTalk' });
  unconfirmed = await createPodcast(db, { ownerId: owner, slug: 'sisp', sourceUrl: `${host.base}/feeds/sisp.xml`, title: 'SISP' });
  await db.query(`UPDATE podcasts SET status = 'active'`);
  host.feeds.set('wvedtalk', '<rss/>');
  host.feeds.set('sisp', '<rss/>');
});
after(async () => {
  await host.close();
  await db.close();
});

const row = async (id: string) => (await db.query<{ status: string; checked: Date; confirmed: Date | null }>(
  `SELECT redirect_status AS status, redirect_checked_at AS checked, redirect_confirmed_at AS confirmed FROM podcasts WHERE id = $1`, [id])).rows[0]!;

test('confirmed redirects are re-checked weekly; a broken one daily until fixed; unconfirmed ones are left to the move checklist', async () => {
  host.redirects.set('/feeds/wvedtalk.xml', [301, 'http://feeds.mine.test/wvedtalk/feed.xml']);
  await saveRedirectResult(db, show, { status: 'ok', detail: 'The old feed permanently redirects here.', hops: [] });
  const confirmed = (await row(show)).confirmed;
  assert.ok(confirmed, 'confirmed the first time it checks out');

  assert.equal(await recheckDueRedirects(db, config), 0, 'checked just now');
  await db.query(`UPDATE podcasts SET redirect_checked_at = now() - interval '6 days' WHERE id = $1`, [show]);
  assert.equal(await recheckDueRedirects(db, config), 0, 'not a week yet');
  await db.query(`UPDATE podcasts SET redirect_checked_at = now() - interval '8 days' WHERE id = $1`, [show]);
  assert.equal(await recheckDueRedirects(db, config), 1);
  assert.equal((await row(show)).status, 'ok');

  // The old host drops the redirect.
  host.redirects.delete('/feeds/wvedtalk.xml');
  await db.query(`UPDATE podcasts SET redirect_checked_at = now() - interval '8 days' WHERE id = $1`, [show]);
  const logs: string[] = [];
  await recheckDueRedirects(db, config, (m) => logs.push(m));
  let r = await row(show);
  assert.equal(r.status, 'none');
  assert.deepEqual(r.confirmed, confirmed, 'still remembered as once confirmed, so the warning shows');
  assert.match(logs[0]!, /wvedtalk: ok → none/);
  // Broken: checked again after a day, not a week.
  await db.query(`UPDATE podcasts SET redirect_checked_at = now() - interval '25 hours' WHERE id = $1`, [show]);
  host.redirects.set('/feeds/wvedtalk.xml', [301, 'http://feeds.mine.test/wvedtalk/feed.xml']);
  assert.equal(await recheckDueRedirects(db, config), 1);
  r = await row(show);
  assert.equal(r.status, 'ok', 'fixed, and the warning clears');

  assert.equal((await row(unconfirmed)).checked, null, 'a show mid-move is never checked in the background');
});
