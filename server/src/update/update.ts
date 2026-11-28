/**
 * Software updates from Site settings.
 *
 * The app can't rebuild its own container (that would stop the process doing the work), so the work is split:
 *   - this module checks GitHub for newer commits and drops an `upgrade.request` file into a control folder;
 *   - a small watcher on the server itself (`upgrade-watch.sh`, installed as the `podsovereign-updater` service)
 *     sees the request, runs `update.sh`, and writes `upgrade.status` back for the dashboard to show.
 * The control folder is `control/` inside the data folder that the container already shares with the server.
 * The watcher also touches `watcher.alive` so the dashboard can say whether the service is running.
 */
import { chmod, mkdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';

export class UpdateError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface UpdateCheck {
  current: string;
  /** False when this build can't be matched to a GitHub commit (a local build, or "dev"). */
  known: boolean;
  updateAvailable: boolean;
  behindBy: number;
  changes: string[];
  latest: string | null;
  checkedAt: string;
  error: string | null;
}

export interface UpdateState {
  state: 'idle' | 'queued' | 'running' | 'success' | 'failed';
  message: string | null;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  revisionBefore: string | null;
  revisionAfter: string | null;
  /** The control folder can be written to. */
  available: boolean;
  /** The updater service on the server is running. */
  watcherAlive: boolean;
}

const HEARTBEAT_MAX_AGE_MS = 120_000;
const CACHE_MS = 60 * 60_000;
let cache: { at: number; key: string; data: UpdateCheck } | null = null;

/** The commit this build was made from: `update.sh` sets it (a short SHA); "dev" for a local run. */
export const currentVersion = () => (process.env.FEEDHOST_VERSION ?? 'dev').trim() || 'dev';
const isSha = (v: string) => /^[0-9a-f]{7,40}$/.test(v);

export async function checkForUpdate(config: Config, force = false): Promise<UpdateCheck> {
  const current = currentVersion();
  const key = `${config.githubRepo}@${config.updateBranch}:${current}`;
  if (!force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;

  const out: UpdateCheck = { current, known: isSha(current), updateAvailable: false, behindBy: 0, changes: [], latest: null, checkedAt: new Date().toISOString(), error: null };
  const api = config.githubApiUrl.replace(/\/+$/, '');
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'podsovereign' };
  try {
    if (out.known) {
      const r = await fetch(`${api}/repos/${config.githubRepo}/compare/${current}...${config.updateBranch}`, { headers, signal: AbortSignal.timeout(10_000) });
      if (r.status === 404) out.error = 'This version isn’t on GitHub (it has local or unpushed changes), so it can’t be compared.';
      else if (!r.ok) out.error = `GitHub answered ${r.status}.`;
      else {
        const j = (await r.json()) as { ahead_by?: number; commits?: Array<{ sha: string; commit?: { message?: string } }> };
        out.behindBy = Number(j.ahead_by ?? 0);
        const commits = j.commits ?? [];
        out.latest = commits.length ? commits[commits.length - 1]!.sha.slice(0, 7) : current.slice(0, 7);
        out.changes = commits.slice(-10).reverse().map((c) => (c.commit?.message ?? '').split('\n')[0]!.slice(0, 120)).filter(Boolean);
        out.updateAvailable = out.behindBy > 0;
      }
    } else {
      const r = await fetch(`${api}/repos/${config.githubRepo}/commits/${config.updateBranch}`, { headers: { ...headers, Accept: 'application/vnd.github.sha' }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) out.latest = (await r.text()).trim().slice(0, 7);
      else out.error = `GitHub answered ${r.status}.`;
    }
  } catch (e) {
    out.error = `Couldn’t reach GitHub: ${(e as Error).message}`;
  }
  // Only a good answer is kept; a failed check is tried again next time.
  if (!out.error) cache = { at: Date.now(), key, data: out };
  return out;
}

const file = (config: Config, name: string) => path.join(config.controlDir, name);

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Write through a temporary file and rename, since the watcher (a different user) may own the old file. */
async function writeAtomic(p: string, text: string) {
  const tmp = `${p}.tmp.${process.pid}`;
  await writeFile(tmp, text, { mode: 0o666 });
  await chmod(tmp, 0o666).catch(() => {});
  await rename(tmp, p);
}

async function writable(config: Config): Promise<boolean> {
  try {
    await mkdir(config.controlDir, { recursive: true });
    await chmod(config.controlDir, 0o777).catch(() => {});
    const probe = file(config, '.write-probe');
    await writeFile(probe, 'ok');
    await unlink(probe);
    return true;
  } catch {
    return false;
  }
}

async function watcherAlive(config: Config): Promise<boolean> {
  try {
    return Date.now() - (await stat(file(config, 'watcher.alive'))).mtimeMs < HEARTBEAT_MAX_AGE_MS;
  } catch {
    return false;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export async function updateState(config: Config): Promise<UpdateState> {
  const s = (await readJson(file(config, 'upgrade.status'))) ?? {};
  const state = (['queued', 'running', 'success', 'failed'] as const).find((x) => x === s.state) ?? 'idle';
  return {
    state,
    message: str(s.message),
    requestedBy: str(s.requested_by),
    startedAt: str(s.started_at),
    finishedAt: str(s.finished_at),
    revisionBefore: str(s.revision_before),
    revisionAfter: str(s.revision_after),
    available: await writable(config),
    watcherAlive: await watcherAlive(config),
  };
}

/** Ask the updater service to apply the update. Asking again while one is waiting or running changes nothing. */
export async function requestUpdate(config: Config, by: string): Promise<{ queued: boolean; state: UpdateState }> {
  const cur = await updateState(config);
  if (!cur.available) throw new UpdateError('The control folder can’t be written to, so one-click updates aren’t available here. Run “sudo ./update.sh” on the server instead.', 503);
  if (cur.state === 'queued' || cur.state === 'running') {
    if (cur.watcherAlive) return { queued: false, state: cur };
  }
  if (!cur.watcherAlive) {
    throw new UpdateError('The updater service on the server isn’t running. On the server, run “sudo ./install-updater.sh” once, or update with “sudo ./update.sh”.', 409);
  }
  const requestedAt = new Date().toISOString();
  await writeAtomic(file(config, 'upgrade.request'), JSON.stringify({ requested_at: requestedAt, requested_by: by }));
  await writeAtomic(file(config, 'upgrade.status'), JSON.stringify({ state: 'queued', message: 'Update requested. The updater will start it within a few seconds.', requested_at: requestedAt, requested_by: by }));
  return { queued: true, state: await updateState(config) };
}
