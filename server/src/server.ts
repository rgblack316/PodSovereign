/**
 * Entry point: runs migrations, starts the import worker and the HTTP server.
 *   DATABASE_URL=postgres://... PUBLIC_BASE_URL=https://feeds.example.com MEDIA_DIR=/var/lib/feedhost/media node --import tsx src/server.ts
 */
import http from 'node:http';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { loadSiteSettings } from './site/settings.js';
import { createPgDb } from './db/pg.js';
import { createApp } from './http/app.js';
import { startImportWorker } from './import/importer.js';
import { cleanupUploads } from './media/uploads.js';
import { startPodpingWorker } from './podping/podping.js';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const config = loadConfig();
  const db = createPgDb(config.databaseUrl);
  await migrate(db, log);
  // Admin-panel site settings override the environment.
  await loadSiteSettings(db, config);

  const worker = process.env.DISABLE_WORKER === '1' ? null : startImportWorker({ db, config, log });
  const podping = startPodpingWorker({ db, config, log });
  // Abandoned uploads and uploaded files never saved into an episode.
  const housekeeping = setInterval(() => void cleanupUploads(db, config, log).catch((e) => log(`cleanup: ${e.message}`)), 3600_000);
  const server = http.createServer(createApp({ db, config, log }));
  server.requestTimeout = 120_000;
  server.listen(config.port, config.host, () =>
    log(`FeedHost listening on ${config.host}:${config.port} (public URL ${config.publicBaseUrl})`),
  );

  const shutdown = async (sig: string) => {
    log(`${sig} received, shutting down`);
    server.close();
    clearInterval(housekeeping);
    await worker?.stop();
    await podping.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
