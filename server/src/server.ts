/**
 * Entry point: runs migrations, starts the import worker and the HTTP server.
 *   DATABASE_URL=postgres://... PUBLIC_BASE_URL=https://feeds.example.com MEDIA_DIR=/var/lib/podsovereign/media node --import tsx src/server.ts
 */
import http from 'node:http';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { loadSiteSettings } from './site/settings.js';
import { createPgDb } from './db/pg.js';
import { createApp } from './http/app.js';
import { startImportWorker } from './import/importer.js';
import { cleanupUploads } from './media/uploads.js';
import { startBackupWorker } from './backup/backups.js';
import { startOp3Worker } from './stats/op3.js';
import { startRedirectWorker } from './http/redirect-check.js';
import { startPodpingWorker } from './podping/podping.js';
import { encryptStoredSecrets, loadSecretKey } from './crypto/secrets.js';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  const config = loadConfig();
  const db = createPgDb(config.databaseUrl);
  await migrate(db, log);
  // Saved passwords and API keys are encrypted with a key kept outside the database.
  await loadSecretKey(process.env.SECRET_KEY, config.secretKeyFile, log);
  await encryptStoredSecrets(db, log);
  // Admin-panel site settings override the environment.
  await loadSiteSettings(db, config);

  const worker = process.env.DISABLE_WORKER === '1' ? null : startImportWorker({ db, config, log });
  const podping = startPodpingWorker({ db, config, log });
  const backups = startBackupWorker({ db, config, log });
  // OP3 stats: each show using the OP3 prefix is refreshed every 6 hours.
  const op3 = startOp3Worker({ db, config, log });
  // Old feeds confirmed to redirect here are re-checked weekly.
  const redirects = startRedirectWorker({ db, config, log });
  // Abandoned uploads and uploaded files never saved into an episode.
  const housekeeping = setInterval(() => void cleanupUploads(db, config, log).catch((e) => log(`cleanup: ${e.message}`)), 3600_000);
  const server = http.createServer(createApp({ db, config, log }));
  server.requestTimeout = 120_000;
  server.listen(config.port, config.host, () =>
    log(`PodSovereign listening on ${config.host}:${config.port} (public URL ${config.publicBaseUrl})`),
  );

  const shutdown = async (sig: string) => {
    log(`${sig} received, shutting down`);
    server.close();
    clearInterval(housekeeping);
    backups.stop();
    op3.stop();
    redirects.stop();
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
