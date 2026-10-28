/**
 * Site settings (admin panel): name, logo, favicon, public address, media
 * address and open registration. Stored in the database and
 * applied onto the shared Config at startup and on every save, so the rest of
 * the app reads them like any other setting.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { maybeOne, type Db, type Queryable } from '../db/db.js';
import { seal, unseal } from '../crypto/secrets.js';
import { storeFor } from '../storage/store.js';
import { mediaPrefix } from '../urls.js';

export class SettingsError extends Error {}

interface Row {
  site_name: string | null;
  public_base_url: string | null;
  media_base_url: string | null;
  allow_registration: boolean | null;
  logo_file: string | null;
  logo_type: string | null;
  favicon_file: string | null;
  favicon_type: string | null;
  previous_hosts: string[];
  storage_provider: string;
  storage_settings: Record<string, string | boolean> | null;
  storage_secret: string | null;
  require_verification: boolean;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: 'tls' | 'starttls' | 'none' | null;
  smtp_user: string | null;
  smtp_password: string | null;
  smtp_from: string | null;
  mail_provider: 'smtp' | 'resend';
  resend_api_key: string | null;
  op3_token: string | null;
  auphonic_key: string | null;
  auphonic_hook_token: string | null;
  updated_at: Date;
}

async function getRow(q: Queryable): Promise<Row> {
  const row = await maybeOne<Row>(q, `SELECT * FROM site_settings WHERE id`);
  if (row) return row;
  await q.query(`INSERT INTO site_settings (id) VALUES (true) ON CONFLICT DO NOTHING`);
  return (await maybeOne<Row>(q, `SELECT * FROM site_settings WHERE id`))!;
}

/** Public base for media links given a settings row: the storage provider's public address, or the media/site address. */
export function mediaBaseFor(config: Config, row: Pick<Row, 'public_base_url' | 'media_base_url' | 'storage_provider' | 'storage_settings'>): string {
  if (row.storage_provider && row.storage_provider !== 'local' && row.storage_settings?.publicUrl) {
    return String(row.storage_settings.publicUrl).replace(/\/+$/, '');
  }
  const env = config.envDefaults;
  return row.media_base_url || env.mediaBaseUrl || row.public_base_url || env.publicBaseUrl;
}

/** Copy saved settings onto the live config (blank = environment default). */
export function applyRow(config: Config, row: Row): void {
  const env = config.envDefaults;
  config.siteName = row.site_name || process.env.SITE_NAME?.trim() || 'PodSovereign';
  config.publicBaseUrl = row.public_base_url || env.publicBaseUrl;
  config.mediaBaseUrl = mediaBaseFor(config, row);
  config.storage = {
    provider: row.storage_provider || 'local',
    settings: row.storage_settings ?? {},
    secret: unseal(row.storage_secret, 'the media storage key'),
  };
  config.allowRegistration = row.allow_registration ?? env.allowRegistration;
  config.cookieSecure = env.cookieSecure ?? config.publicBaseUrl.startsWith('https://');
  config.previousHosts = row.previous_hosts ?? [];
  config.requireVerification = row.require_verification ?? true;
  const resendKey = unseal(row.resend_api_key, 'the Resend API key');
  config.mail =
    row.mail_provider === 'resend'
      ? resendKey && row.smtp_from
        ? { provider: 'resend', apiKey: resendKey, from: row.smtp_from, apiUrl: config.resendApiUrl }
        : null
      : row.smtp_host && row.smtp_from
        ? {
            provider: 'smtp',
            smtp: {
              host: row.smtp_host,
              port: row.smtp_port ?? (row.smtp_security === 'tls' ? 465 : 587),
              security: row.smtp_security ?? 'starttls',
              user: row.smtp_user,
              password: unseal(row.smtp_password, 'the SMTP password'),
              from: row.smtp_from,
            },
          }
        : null;
  config.op3Token = unseal(row.op3_token, 'the OP3 API token');
  config.auphonicKey = unseal(row.auphonic_key, 'the Auphonic API key');
  config.auphonicHookToken = row.auphonic_hook_token;
  config.siteVersion = new Date(row.updated_at).getTime();
}

export async function loadSiteSettings(db: Db, config: Config): Promise<void> {
  applyRow(config, await getRow(db));
}

/** What the admin panel shows. Secrets are never sent back. */
export async function siteSettingsView(db: Db, config: Config) {
  const row = await getRow(db);
  return {
    siteName: config.siteName,
    publicBaseUrl: config.publicBaseUrl,
    mediaBaseUrl: row.media_base_url ?? '',
    allowRegistration: config.allowRegistration,
    storageProvider: row.storage_provider,
    requireVerification: config.requireVerification,
    mail: {
      configured: !!config.mail,
      provider: row.mail_provider ?? 'smtp',
      from: row.smtp_from ?? '',
      resendKeySet: !!row.resend_api_key,
    },
    smtp: {
      configured: config.mail?.provider === 'smtp',
      host: row.smtp_host ?? '',
      port: row.smtp_port ?? null,
      security: row.smtp_security ?? 'starttls',
      user: row.smtp_user ?? '',
      passwordSet: !!row.smtp_password,
      from: row.smtp_from ?? '',
    },
    op3: { tokenSet: !!config.op3Token },
    auphonic: { keySet: !!config.auphonicKey },
    hasLogo: !!row.logo_file,
    hasFavicon: !!row.favicon_file,
    previousHosts: config.previousHosts,
    showCount: (await maybeOne<{ n: number }>(db, `SELECT count(*)::int AS n FROM podcasts`))!.n,
  };
}

// ───────────── validation ─────────────

/** An origin like https://podcasts.example.com (no path, no trailing slash). */
export function normalizeBaseUrl(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new SettingsError(`${field} is required`);
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new SettingsError(`${field} must be a full address, like https://podcasts.example.com`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SettingsError(`${field} must start with https://`);
  if (u.username || u.password || u.search || u.hash) throw new SettingsError(`${field} can't include a login, ? or #`);
  if (u.pathname !== '/' && u.pathname !== '') {
    throw new SettingsError(`${field} can’t include a path. Use just the address, like https://${u.host}`);
  }
  return u.origin;
}

export interface SettingsInput {
  siteName?: unknown;
  publicBaseUrl?: unknown;
  mediaBaseUrl?: unknown;
  allowRegistration?: unknown;
  requireVerification?: unknown;
  /** Email server, or null to remove it. A blank password keeps the saved one. */
  smtp?: unknown;
  /** Resend: { apiKey?, from }. A blank key keeps the saved one. null removes it. */
  resend?: unknown;
  /** OP3 API token; '' or null removes it. */
  op3Token?: unknown;
  /** Auphonic API key; '' or null removes it. */
  auphonicKey?: unknown;
}

export interface SaveResult {
  addressChanged: boolean;
  rewrittenShows: number;
}

/**
 * Save settings. When the public or media address changes, every stored link
 * to this server's media is rewritten to the new address, and the old
 * hostname is remembered so requests that still reach us there are redirected.
 */
export async function saveSiteSettings(db: Db, config: Config, input: SettingsInput): Promise<SaveResult> {
  const before = { publicBaseUrl: config.publicBaseUrl, mediaBaseUrl: config.mediaBaseUrl };
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };

  if (input.siteName !== undefined) {
    if (typeof input.siteName !== 'string' || !input.siteName.trim()) throw new SettingsError('Site name is required');
    if (input.siteName.trim().length > 60) throw new SettingsError('Site name can be at most 60 characters');
    set('site_name', input.siteName.trim());
  }
  let newPublic = before.publicBaseUrl;
  if (input.publicBaseUrl !== undefined) {
    newPublic = normalizeBaseUrl(input.publicBaseUrl, 'Site address');
    set('public_base_url', newPublic);
  }
  let mediaSetting: string | null | undefined;
  if (input.mediaBaseUrl !== undefined) {
    mediaSetting = input.mediaBaseUrl === null || input.mediaBaseUrl === '' ? null : normalizeBaseUrl(input.mediaBaseUrl, 'Media address');
    set('media_base_url', mediaSetting);
  }
  if (input.allowRegistration !== undefined) {
    if (typeof input.allowRegistration !== 'boolean') throw new SettingsError('allowRegistration must be true or false');
    set('allow_registration', input.allowRegistration);
  }
  if (input.requireVerification !== undefined) {
    if (typeof input.requireVerification !== 'boolean') throw new SettingsError('requireVerification must be true or false');
    set('require_verification', input.requireVerification);
  }
  if (input.resend !== undefined) {
    if (input.resend === null) {
      set('resend_api_key', null);
    } else {
      const o = (input.resend ?? {}) as Record<string, unknown>;
      const from = validateFrom(o.from);
      const key = typeof o.apiKey === 'string' ? o.apiKey.trim() : '';
      const row = await getRow(db);
      if (key && !/^re_[A-Za-z0-9_-]{8,}$/.test(key)) throw new SettingsError('A Resend API key starts with re_');
      if (!key && !row.resend_api_key) throw new SettingsError('Enter your Resend API key');
      if (key) set('resend_api_key', seal(key));
      set('smtp_from', from);
      set('mail_provider', 'resend');
    }
  }
  if (input.smtp !== undefined) {
    if (input.smtp === null) {
      for (const c of ['smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_password']) set(c, null);
      set('mail_provider', 'smtp');
    } else {
      const m = validateSmtp(input.smtp);
      set('mail_provider', 'smtp');
      set('smtp_host', m.host);
      set('smtp_port', m.port);
      set('smtp_security', m.security);
      set('smtp_user', m.user);
      if (m.password !== undefined) set('smtp_password', seal(m.password));
      set('smtp_from', m.from);
    }
  }
  if (input.op3Token !== undefined) {
    const t = typeof input.op3Token === 'string' ? input.op3Token.trim() : '';
    if (t && !/^[A-Za-z0-9._~+/=-]{8,500}$/.test(t)) throw new SettingsError('That doesn’t look like an OP3 API token');
    set('op3_token', seal(t || null));
  }
  if (input.auphonicKey !== undefined) {
    const t = typeof input.auphonicKey === 'string' ? input.auphonicKey.trim() : '';
    if (t && !/^[A-Za-z0-9._~+/=-]{8,500}$/.test(t)) throw new SettingsError('That doesn’t look like an Auphonic API key');
    set('auphonic_key', seal(t || null));
    // The callback address's secret, made once.
    const row = await getRow(db);
    if (t && !row.auphonic_hook_token) set('auphonic_hook_token', randomBytes(24).toString('hex'));
  }
  if (!sets.length) return { addressChanged: false, rewrittenShows: 0 };

  const row = await getRow(db);
  const newMedia = mediaBaseFor(config, {
    ...row,
    public_base_url: newPublic,
    media_base_url: mediaSetting === undefined ? row.media_base_url : mediaSetting,
  });
  const oldHost = new URL(before.publicBaseUrl).host;
  const newHost = new URL(newPublic).host;
  const hostChanged = oldHost !== newHost;

  let rewrittenShows = 0;
  await db.tx(async (q) => {
    if (hostChanged) {
      const hosts = new Set(row.previous_hosts);
      hosts.add(oldHost);
      hosts.delete(newHost);
      vals.push(JSON.stringify([...hosts]));
      sets.push(`previous_hosts = ARRAY(SELECT jsonb_array_elements_text($${vals.length}::jsonb))`);
    }
    await q.query(`UPDATE site_settings SET ${sets.join(', ')}, updated_at = now() WHERE id`, vals);
    if (newMedia !== before.mediaBaseUrl) rewrittenShows = await rewriteMediaBase(q, before.mediaBaseUrl, newMedia);
    if (newPublic !== before.publicBaseUrl || newMedia !== before.mediaBaseUrl) {
      await q.query(`UPDATE podcasts SET feed_cache_xml = NULL, feed_cache_etag = NULL, redirect_status = NULL`);
    }
  });
  applyRow(config, await getRow(db));
  if (newMedia !== before.mediaBaseUrl) await rewriteChapterFiles(db, config, before.mediaBaseUrl, newMedia);
  return { addressChanged: newPublic !== before.publicBaseUrl || newMedia !== before.mediaBaseUrl, rewrittenShows };
}

/**
 * Point every stored link to our media at a new base address. Only links
 * under <old>/<slug>/media/ are touched; GUIDs are never changed.
 */
export async function rewriteMediaBase(q: Queryable, oldBase: string, newBase: string): Promise<number> {
  const { rows } = await q.query<{ id: string; slug: string }>(`SELECT id, slug FROM podcasts`);
  for (const p of rows) {
    const from = oldBase + mediaPrefix(p.slug);
    const to = newBase + mediaPrefix(p.slug);
    const args = [p.id, from, to];
    await q.query(
      `UPDATE podcasts SET image_url = replace(image_url, $2, $3), description = replace(description, $2, $3) WHERE id = $1`,
      args,
    );
    await q.query(
      `UPDATE episodes SET enclosure_url = replace(enclosure_url, $2, $3), itunes_image_url = replace(itunes_image_url, $2, $3),
              description = replace(description, $2, $3) WHERE podcast_id = $1`,
      args,
    );
    await q.query(
      `UPDATE tag_elements SET attributes = replace(attributes::text, $2, $3)::json, value = replace(value, $2, $3),
              children = replace(children::text, $2, $3)::json WHERE podcast_id = $1`,
      args,
    );
  }
  return rows.length;
}

/** Chapter files hold image links too (wherever they're stored). */
export async function rewriteChapterFiles(db: Db, config: Config, oldBase: string, newBase: string): Promise<void> {
  const { rows } = await db.query<{ id: string; storage_key: string; storage_provider: string; slug: string }>(
    `SELECT m.id, m.storage_key, m.storage_provider, p.slug FROM media_files m JOIN podcasts p ON p.id = m.podcast_id
      WHERE m.kind = 'chapters' AND m.status = 'done' AND m.storage_key IS NOT NULL`,
  );
  for (const r of rows) {
    const from = oldBase + mediaPrefix(r.slug);
    try {
      const store = storeFor(config, r.storage_provider);
      const text = (await store.getBuffer(r.storage_key)).toString('utf8');
      if (!text.includes(from)) continue;
      const body = Buffer.from(text.split(from).join(newBase + mediaPrefix(r.slug)));
      await store.putBuffer(r.storage_key, body, 'application/json');
      await db.query(`UPDATE media_files SET bytes = $2, sha256 = $3 WHERE id = $1`, [
        r.id,
        body.length,
        createHash('sha256').update(body).digest('hex'),
      ]);
    } catch {
      /* file missing or storage unreachable — nothing to rewrite */
    }
  }
}

// ───────────── email (SMTP) ─────────────

export interface SmtpInput {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  user: string | null;
  /** undefined = keep the saved password */
  password?: string | null;
  from: string;
}

export function validateFrom(raw: unknown): string {
  const from = typeof raw === 'string' ? raw.trim() : '';
  const fromAddr = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(fromAddr) || /[\r\n]/.test(from)) {
    throw new SettingsError('“From” must be an email address, optionally with a name: Studio Name <podcasts@example.com>');
  }
  return from;
}

export function validateSmtp(raw: unknown): SmtpInput {
  const o = (raw ?? {}) as Record<string, unknown>;
  const host = typeof o.host === 'string' ? o.host.trim() : '';
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new SettingsError('Enter the mail server’s hostname, like smtp.example.com');
  const security = o.security === 'tls' || o.security === 'none' ? o.security : 'starttls';
  const port = o.port === undefined || o.port === '' || o.port === null ? (security === 'tls' ? 465 : 587) : Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SettingsError('Port must be a number between 1 and 65535');
  const from = validateFrom(o.from);
  const user = typeof o.user === 'string' && o.user.trim() ? o.user.trim() : null;
  const password = typeof o.password === 'string' && o.password ? o.password : undefined;
  return { host, port, security, user, password, from };
}

// ───────────── logo & favicon ─────────────

export type AssetKind = 'logo' | 'favicon';

const MAX_ASSET_BYTES = 1024 * 1024;

/** Detect the image type from its bytes (never trust the declared type). */
export function sniffImage(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  const head = buf.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Store an uploaded logo or favicon (sent as a data: URL). */
export async function saveSiteAsset(db: Db, config: Config, kind: AssetKind, dataUrl: unknown): Promise<void> {
  if (typeof dataUrl !== 'string') throw new SettingsError('Choose an image file to upload');
  const m = /^data:[\w.+/-]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw new SettingsError('The image could not be read; try another file');
  const buf = Buffer.from(m[1]!, 'base64');
  if (!buf.length) throw new SettingsError('That file is empty');
  if (buf.length > MAX_ASSET_BYTES) throw new SettingsError('Images must be 1 MB or smaller');
  const type = sniffImage(buf);
  const allowed = kind === 'favicon'
    ? ['image/png', 'image/svg+xml', 'image/x-icon', 'image/gif']
    : ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'];
  if (!type || !allowed.includes(type)) {
    throw new SettingsError(kind === 'favicon' ? 'Use a PNG, SVG or ICO file for the favicon' : 'Use a PNG, JPEG, WebP or SVG file for the logo');
  }
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/gif': 'gif' }[type];
  const file = `${kind}-${Date.now()}.${ext}`;
  await mkdir(config.siteDir, { recursive: true });
  await writeFile(path.join(config.siteDir, file), buf);

  const old = await getRow(db);
  await db.query(`UPDATE site_settings SET ${kind}_file = $1, ${kind}_type = $2, updated_at = now() WHERE id`, [file, type]);
  const previous = kind === 'logo' ? old.logo_file : old.favicon_file;
  if (previous) await rm(path.join(config.siteDir, previous), { force: true });
  applyRow(config, await getRow(db));
}

export async function removeSiteAsset(db: Db, config: Config, kind: AssetKind): Promise<void> {
  const old = await getRow(db);
  const previous = kind === 'logo' ? old.logo_file : old.favicon_file;
  await db.query(`UPDATE site_settings SET ${kind}_file = NULL, ${kind}_type = NULL, updated_at = now() WHERE id`);
  if (previous) await rm(path.join(config.siteDir, previous), { force: true });
  applyRow(config, await getRow(db));
}

/** The uploaded asset, or null to fall back to the built-in icon. */
export async function readSiteAsset(db: Db, config: Config, kind: AssetKind): Promise<{ body: Buffer; type: string } | null> {
  const row = await getRow(db);
  const file = kind === 'logo' ? row.logo_file : row.favicon_file;
  const type = kind === 'logo' ? row.logo_type : row.favicon_type;
  if (!file || !type) return null;
  try {
    return { body: await readFile(path.join(config.siteDir, file)), type };
  } catch {
    return null;
  }
}
