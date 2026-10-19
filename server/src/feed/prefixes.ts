/**
 * Stats/analytics prefix support.
 *
 * Media URLs are stored clean. When a feed is rendered, the podcaster's
 * enabled prefixes (the checkboxes in Settings) are chained in front of each
 * enclosure URL, outermost first:
 *
 *   https://op3.dev/e/dts.podtrac.com/redirect.mp3/host.com/media/ep1.mp3
 *
 * On import, any prefixes already on the source feed are detected, stripped
 * (so the import's own media downloads don't inflate anyone's stats) and
 * offered back as pre-checked settings.
 */

export interface PrefixService {
  key: string;
  name: string;
  /** Prefix template; `{param}` is replaced with the podcaster's ID/keyword. */
  template: string;
  paramLabel?: string;
  helpUrl?: string;
}

/** Built-in catalog — keep in sync with the prefix_services seed in the migration. */
export const PREFIX_SERVICES: readonly PrefixService[] = [
  { key: 'op3', name: 'OP3', template: 'https://op3.dev/e/', helpUrl: 'https://op3.dev' },
  { key: 'podtrac', name: 'Podtrac', template: 'https://dts.podtrac.com/redirect.mp3/', helpUrl: 'https://analytics.podtrac.com' },
  { key: 'podscribe', name: 'Podscribe', template: 'https://pscrb.fm/rss/p/', helpUrl: 'https://podscribe.com' },
  { key: 'magellan', name: 'Magellan AI', template: 'https://mgln.ai/e/{param}/', paramLabel: 'Account ID', helpUrl: 'https://magellan.ai' },
  { key: 'blubrry', name: 'Blubrry Stats', template: 'https://media.blubrry.com/{param}/', paramLabel: 'Show keyword', helpUrl: 'https://blubrry.com' },
  { key: 'custom', name: 'Custom prefix', template: '{param}', paramLabel: 'Full prefix URL' },
];

const SERVICE_BY_KEY = new Map(PREFIX_SERVICES.map((s) => [s.key, s]));

export interface PrefixSetting {
  serviceKey: string;
  enabled: boolean;
  paramValue?: string | null;
  /** 0 = outermost. */
  position: number;
}

export class PrefixError extends Error {}

const PARAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Resolve one setting to a concrete prefix URL (validated). */
export function resolvePrefix(setting: PrefixSetting): string {
  const svc = SERVICE_BY_KEY.get(setting.serviceKey);
  if (!svc) throw new PrefixError(`Unknown prefix service "${setting.serviceKey}"`);
  const needsParam = svc.template.includes('{param}');
  const param = (setting.paramValue ?? '').trim();

  if (svc.key === 'custom') return validateCustomPrefix(param);
  if (!needsParam) return svc.template;
  if (!PARAM_RE.test(param)) {
    throw new PrefixError(`${svc.name}: ${svc.paramLabel ?? 'ID'} is required (letters, numbers, . _ - only)`);
  }
  return svc.template.replace('{param}', param);
}

export function validateCustomPrefix(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PrefixError('Custom prefix must be a full URL, e.g. https://example.com/track/');
  }
  if (u.protocol !== 'https:') throw new PrefixError('Custom prefix must use https://');
  if (u.search || u.hash) throw new PrefixError('Custom prefix cannot contain ? or #');
  const s = u.toString();
  return s.endsWith('/') ? s : `${s}/`;
}

/** Enabled settings → ordered prefix URLs (outermost first). */
export function buildPrefixChain(settings: PrefixSetting[]): string[] {
  return settings
    .filter((s) => s.enabled)
    .sort((a, b) => a.position - b.position)
    .map(resolvePrefix);
}

export function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

/** Wrap a clean media URL in the prefix chain. */
export function applyPrefixes(url: string, chain: string[]): string {
  let out = url;
  for (let i = chain.length - 1; i >= 0; i--) out = chain[i] + stripScheme(out);
  return out;
}

// ───────────── Detection (import) ─────────────

interface Pattern {
  key: string;
  re: RegExp;
  /** Prefix is defunct — strip it, don't re-enable. */
  remove?: boolean;
  /** Treat as a custom prefix, keeping the matched URL. */
  custom?: boolean;
}

const PATTERNS: Pattern[] = [
  { key: 'op3', re: /^op3\.dev\/e(?:,[^/]*)?\//i },
  { key: 'podtrac', re: /^(?:dts\.podtrac\.com|(?:www\.)?podtrac\.com\/pts)\/redirect\.[a-z0-9]+\//i },
  { key: 'podscribe', re: /^(?:pscrb\.fm|verifi\.podscribe\.com)\/rss\/p\//i },
  { key: 'magellan', re: /^mgln\.ai\/e\/([A-Za-z0-9_.-]+)\//i },
  { key: 'blubrry', re: /^media\.blubrry\.com\/([A-Za-z0-9_.-]+)\//i },
  { key: 'chartable', re: /^chtbl\.com\/track\/[^/]+\//i, remove: true },
  { key: 'custom', re: /^pdst\.fm\/e\//i, custom: true },
  { key: 'custom', re: /^clrtpod\.com\/m\//i, custom: true },
  { key: 'custom', re: /^arttrk\.com\/p\/[^/]+\//i, custom: true },
];

/** What remains after a prefix must still look like host/path, otherwise it wasn't a prefix. */
const LOOKS_LIKE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\//i;

export interface DetectResult {
  cleanUrl: string;
  detected: PrefixSetting[];
  /** Defunct prefixes that were stripped (e.g. Chartable). */
  removed: string[];
}

export function detectPrefixes(url: string): DetectResult {
  const isHttps = !/^http:\/\//i.test(url);
  let rest = stripScheme(url);
  const detected: PrefixSetting[] = [];
  const removed: string[] = [];

  for (let guard = 0; guard < 10; guard++) {
    let matched = false;
    for (const p of PATTERNS) {
      const m = p.re.exec(rest);
      if (!m) continue;
      const remainder = rest.slice(m[0].length);
      const inner = stripScheme(remainder);
      if (!LOOKS_LIKE_HOST.test(inner)) continue;
      if (p.remove) removed.push(`https://${m[0]}`);
      else
        detected.push({
          serviceKey: p.key,
          enabled: true,
          paramValue: p.custom ? `https://${m[0]}` : (m[1] ?? null),
          position: detected.length,
        });
      rest = inner;
      matched = true;
      break;
    }
    if (!matched) break;
  }

  if (!detected.length && !removed.length) return { cleanUrl: url, detected, removed };
  // Prefix services don't tell us the origin scheme; assume https unless the whole URL was http.
  return { cleanUrl: `${isHttps ? 'https' : 'http'}://${rest}`, detected, removed };
}
