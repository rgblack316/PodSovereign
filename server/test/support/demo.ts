/**
 * Local demo: fresh database, fake "old host" with real artwork, two imported
 * shows, one on air. Used for screenshots and for trying the dashboard.
 *   npx tsx test/support/demo.ts   →  http://127.0.0.1:8099
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { createApp } from '../../src/http/app.js';
import { claimNextJob, enqueueImport, runImportJob, startImportWorker } from '../../src/import/importer.js';
import { startFakeS3 } from './fake-storage.js';
import { startFakeSmtp } from './fake-smtp.js';
import { loadSiteSettings } from '../../src/site/settings.js';
import { createLiveItem, setLiveStatus } from '../../src/live/live.js';
import { setShowPodping } from '../../src/podping/podping.js';
import { hashPassword } from '../../src/auth/passwords.js';
import { fixtureOn, setupDb, startOldHost, tempDir, testConfig } from './env.js';

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH ?? 'sharp');

async function art(bg: string, fg: string, text: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <rect width="600" height="600" fill="${bg}"/>
    <circle cx="470" cy="130" r="80" fill="${fg}" opacity="0.35"/>
    <rect x="60" y="360" width="480" height="8" fill="${fg}"/>
    <text x="60" y="320" font-family="DejaVu Sans" font-weight="bold" font-size="76" fill="${fg}">${text}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

const port = Number(process.env.DEMO_PORT ?? 8099);
const db = await setupDb('feedhost_demo');
const host = await startOldHost();
const config = testConfig({
  ...(process.env.NOMINATIM_URL ? { nominatimUrl: process.env.NOMINATIM_URL } : {}),
  mediaDir: await tempDir('demo-media'),
  siteDir: await tempDir('demo-site'),
  publicBaseUrl: `http://127.0.0.1:${port}`,
  mediaBaseUrl: `http://127.0.0.1:${port}`,
  allowRegistration: false,
  podpingHubUrl: 'http://127.0.0.1:1/pubnotify',
});

const { rows } = await db.query<{ id: string }>(
  `INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, $2, $3, true) RETURNING id`,
  ['randy@johnscreekstudios.com', await hashPassword('demo password 123'), 'Randy'],
);
const randy = rows[0]!.id;

host.files.set('/old/art-3000.jpg', { type: 'image/jpeg', body: await art('#20343f', '#f2c14e', 'CREEKSIDE') });
host.files.set('/old/art2.jpg', { type: 'image/jpeg', body: await art('#7a2e3a', '#f6efe6', 'NIGHT SHIFT') });
host.feeds.set('creek', fixtureOn(host.base, (x) => x
  .replace('<title>The Test Show &amp; Friends</title>', '<title>Creekside Conversations</title>')
  .replace('<itunes:author>Randy Example</itunes:author>', '<itunes:author>John’s Creek Studios</itunes:author>')
  .replace('<title>Episode 2: Prefixes &amp; Things</title>', '<title>Rebuilding the old mill bridge</title>')
  .replace('<title>Episode 1</title>', '<title>Welcome to Creekside</title>')));
host.feeds.set('night', fixtureOn(host.base, (x) => x
  .replace('917393e3', 'eeeeeeee')
  .replace('<title>The Test Show &amp; Friends</title>', '<title>The Night Shift Radio Hour</title>')
  .replace('<itunes:author>Randy Example</itunes:author>', '<itunes:author>Marisol Vega</itunes:author>')
  .replace(/art-3000\.jpg/g, 'art2.jpg')));

for (const [name, slug] of [['creek', 'creekside'], ['night', 'night-shift']] as const) {
  await enqueueImport(db, randy, `${host.base}/feeds/${name}.xml`, { slug });
  await runImportJob({ db, config }, (await claimNextJob(db))!);
}
const ids = (await db.query<{ id: string; slug: string }>(`SELECT id, slug FROM podcasts ORDER BY slug`)).rows;
const creek = ids.find((r) => r.slug === 'creekside')!.id;
const night = ids.find((r) => r.slug === 'night-shift')!.id;

// Creekside: fully moved. Night Shift: mid-move, on air.
await db.query(`UPDATE podcasts SET redirect_status = 'ok', redirect_detail = 'The old feed permanently redirects here.', redirect_checked_at = now() WHERE id = $1`, [creek]);
await setShowPodping(db, config, creek, true);
await db.query(`DELETE FROM podping_queue`);
const li = await createLiveItem(db, night, {
  title: 'Friday request line',
  start: new Date(Date.now() - 20 * 60_000).toISOString(),
  end: new Date(Date.now() + 100 * 60_000).toISOString(),
  streamUrl: 'https://stream.johnscreekstudios.com/nightshift.mp3',
  contentLinks: [{ href: 'https://youtube.com/live/nightshift', text: 'Watch on YouTube' }],
});
await setLiveStatus(db, config, night, li.id, 'live');
await createLiveItem(db, night, {
  title: 'Election night special',
  start: '2026-11-03T20:00:00-05:00',
  streamUrl: 'https://stream.johnscreekstudios.com/nightshift.mp3',
});

// Verification on, with a fake mail server that logs the codes it receives.
const smtp = await startFakeSmtp();
const logMail = setInterval(() => {
  while (smtp.messages.length) console.log(`email to ${smtp.messages[0]!.to.join(',')}: ${smtp.messages.shift()!.subject}`);
}, 200);
logMail.unref();
await db.query(`UPDATE site_settings SET require_verification = true, smtp_host = '127.0.0.1', smtp_port = $1, smtp_security = 'none', smtp_from = 'Johns Creek Studios <podcasts@johnscreekstudios.com>'`, [smtp.port]);
await loadSiteSettings(db, config);
host.feeds.set('fresh', fixtureOn(host.base, (x) => x
  .replace('917393e3', 'abcdabcd')
  .replace('<title>The Test Show &amp; Friends</title>', '<title>Morning Mill Report</title>')
  .replace('<itunes:email>owner@example.com</itunes:email>', '<itunes:email>marisol@morningmill.fm</itunes:email>')));
console.log(`feed to import: ${host.base}/feeds/fresh.xml`);

// A local fake S3 bucket for trying Media storage → "Other S3-compatible".
const s3 = await startFakeS3({ bucket: 'demo-bucket', accessKeyId: 'DEMOKEY', secret: 'demo-secret', region: 'us-east-1' });
console.log(`fake S3: endpoint ${s3.endpoint}  bucket demo-bucket  key DEMOKEY / demo-secret  public ${s3.publicUrl}`);
startImportWorker({ db, config, log: console.log }, 500);

const server = http.createServer(createApp({ db, config, log: console.log }));
server.listen(port, '127.0.0.1', () => console.log(`demo ready on http://127.0.0.1:${port}  (randy@johnscreekstudios.com / demo password 123)`));
