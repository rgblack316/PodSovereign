/**
 * Where copied media lives: on this server's disk (MEDIA_DIR) or with a
 * storage provider (R2, B2, S3, Wasabi, Spaces, Bunny, other S3-compatible).
 * Every file operation in the app goes through a MediaStore.
 *
 * Keys mirror the public URL layout: <slug>/media/<type>/<file>
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { fetchFeedText } from '../import/http.js';
import { providerById, toClient, type RemoteClient, type StorageSettings } from './providers.js';
import { S3Client } from './s3.js';

export interface MediaStore {
  /** 'local' or a provider id. */
  readonly id: string;
  readonly isLocal: boolean;
  /** Public base for media URLs (no trailing slash). */
  readonly publicBase: string;
  putFile(key: string, localFile: string, info: { size: number; contentType: string; sha256?: string }): Promise<{ storagePath: string | null }>;
  putBuffer(key: string, body: Buffer, contentType: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer>;
  getToFile(key: string, dest: string): Promise<void>;
  /** Copy a stored file to another key on the provider's side, when the provider can (else undefined). */
  copy?(fromKey: string, toKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface StorageState {
  provider: string; // 'local' or provider id
  settings: StorageSettings;
  secret: string | null;
}

/** Disk path for a key, refusing anything that escapes MEDIA_DIR. */
export function localPath(mediaDir: string, key: string): string {
  const root = path.resolve(mediaDir);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error(`Invalid media key ${key}`);
  return full;
}

class LocalStore implements MediaStore {
  readonly id = 'local';
  readonly isLocal = true;
  constructor(private mediaDir: string, readonly publicBase: string) {}

  async putFile(key: string, localFile: string) {
    const dest = localPath(this.mediaDir, key);
    if (path.resolve(localFile) !== dest) {
      await mkdir(path.dirname(dest), { recursive: true });
      await rename(localFile, dest).catch(async () => {
        await copyFile(localFile, dest);
        await rm(localFile, { force: true });
      });
    }
    return { storagePath: dest };
  }
  async putBuffer(key: string, body: Buffer) {
    const dest = localPath(this.mediaDir, key);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, body);
  }
  getBuffer(key: string) {
    return readFile(localPath(this.mediaDir, key));
  }
  async getToFile(key: string, dest: string) {
    await copyFile(localPath(this.mediaDir, key), dest);
  }
  async copy(fromKey: string, toKey: string) {
    const dest = localPath(this.mediaDir, toKey);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(localPath(this.mediaDir, fromKey), dest);
  }
  async delete(key: string) {
    await rm(localPath(this.mediaDir, key), { force: true });
  }
  async deletePrefix(prefix: string) {
    await rm(localPath(this.mediaDir, prefix.replace(/\/+$/, '')), { recursive: true, force: true });
  }
}

class RemoteStore implements MediaStore {
  readonly isLocal = false;
  readonly copy?: (fromKey: string, toKey: string) => Promise<void>;
  constructor(readonly id: string, private client: RemoteClient, readonly publicBase: string) {
    if (client instanceof S3Client) this.copy = (fromKey, toKey) => client.copy(fromKey, toKey);
  }

  async putFile(key: string, localFile: string, info: { size: number; contentType: string; sha256?: string }) {
    await this.client.putFile(key, localFile, info.size, info.contentType, info.sha256);
    await rm(localFile, { force: true }); // the provider holds it now
    return { storagePath: null };
  }
  putBuffer(key: string, body: Buffer, contentType: string) {
    return this.client.putBuffer(key, body, contentType);
  }
  getBuffer(key: string) {
    return this.client.getBuffer(key);
  }
  getToFile(key: string, dest: string) {
    return this.client.getToFile(key, dest);
  }
  delete(key: string) {
    return this.client.delete(key);
  }
  async deletePrefix(prefix: string) {
    await this.client.deletePrefix(prefix);
  }
}

export function createStore(config: Config, state: StorageState): MediaStore {
  if (state.provider === 'local') return new LocalStore(config.mediaDir, config.mediaBaseUrl);
  if (!state.secret) throw new Error('Storage secret is missing');
  return new RemoteStore(state.provider, toClient(state.provider, state.settings, state.secret), String(state.settings.publicUrl));
}

/** The store new files go to. */
export const activeStore = (config: Config) => createStore(config, config.storage);

/** Store for a file that was saved under a given provider (it may differ from the active one mid-move). */
export function storeFor(config: Config, provider: string | null | undefined): MediaStore {
  if (!provider || provider === 'local') return new LocalStore(config.mediaDir, config.mediaBaseUrl);
  if (provider === config.storage.provider) return activeStore(config);
  if (config.storageMoveFrom && provider === config.storageMoveFrom.provider) return createStore(config, config.storageMoveFrom);
  throw new Error(`Files are stored with ${provider}, which is no longer configured`);
}

// ───────────── connection test ─────────────

export interface TestStep {
  step: string;
  ok: boolean;
  detail: string;
}

/**
 * Upload a small test file, read it back through the provider's API, fetch
 * it from the public address (what podcast apps will do), then delete it.
 */
export async function testConnection(config: Config, state: StorageState): Promise<{ ok: boolean; steps: TestStep[] }> {
  const steps: TestStep[] = [];
  const name = providerById(state.provider)?.name ?? state.provider;
  let store: MediaStore;
  try {
    store = createStore(config, state);
  } catch (e) {
    return { ok: false, steps: [{ step: 'Connect', ok: false, detail: (e as Error).message }] };
  }
  const key = `_podsovereign-test/${Date.now()}-${randomBytes(4).toString('hex')}.txt`;
  const body = Buffer.from(`PodSovereign connection test ${new Date().toISOString()}\n`);

  const run = async (step: string, fn: () => Promise<string>) => {
    try {
      steps.push({ step, ok: true, detail: await fn() });
      return true;
    } catch (e) {
      steps.push({ step, ok: false, detail: (e as Error).message });
      return false;
    }
  };

  const uploaded = await run('Upload a test file', async () => {
    await store.putBuffer(key, body, 'text/plain');
    return `Uploaded to ${name}.`;
  });
  if (uploaded) {
    await run('Read it back', async () => {
      const got = await store.getBuffer(key);
      if (!got.equals(body)) throw new Error('The file came back different from what was uploaded');
      return 'Read back through the storage API.';
    });
    await run('Download it from the public address', async () => {
      const url = `${store.publicBase}/${key}`;
      let text: string;
      try {
        ({ text } = await fetchFeedText(url, { allowPrivate: config.allowPrivateNetworks, maxBytes: 64 * 1024, timeoutMs: 20_000 }));
      } catch (e) {
        throw new Error(
          `Couldn't download ${url} (${(e as Error).message}). Podcast apps need to reach files at the public address: check it’s right and that the bucket or CDN allows public access.`,
        );
      }
      if (text !== body.toString()) throw new Error(`${url} answered, but not with the test file. Check the public address points at this bucket.`);
      return `Podcast apps will be able to download files from ${store.publicBase}.`;
    });
    await run('Delete the test file', async () => {
      await store.delete(key);
      return 'Deleted.';
    });
  }
  return { ok: steps.every((s) => s.ok), steps };
}
