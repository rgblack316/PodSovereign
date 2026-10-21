/**
 * Try the parser/builder against a real feed:
 *
 *   npm run preview -- https://example.com/feed.xml
 *   npm run preview -- ./feed.xml --prefix op3,podtrac --out rebuilt.xml
 *
 * Prints what was imported (tags, warnings, detected prefixes, media to copy)
 * and writes the regenerated feed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { buildFeed, buildPrefixChain, collectMediaRefs, parseFeed, type PrefixSetting } from '../feed/index.js';

const MAX_BYTES = 25 * 1024 * 1024;

async function load(src: string): Promise<string> {
  if (!/^https?:\/\//i.test(src)) return readFile(src, 'utf8');
  const res = await fetch(src, {
    headers: { 'User-Agent': 'PodSovereign/0.1 (feed import)', Accept: 'application/rss+xml, application/xml, text/xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${src}`);
  if (res.url !== src) console.log(`↪ redirected to ${res.url}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`Feed is larger than ${MAX_BYTES} bytes`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`Feed is larger than ${MAX_BYTES} bytes`);
  return text;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const src = process.argv[2];
  if (!src || src.startsWith('--')) {
    console.error('Usage: npm run preview -- <feed-url-or-file> [--prefix op3,podtrac] [--out rebuilt.xml]');
    process.exit(1);
  }
  const { feed, warnings, detectedPrefixes, removedPrefixes } = parseFeed(await load(src));
  const c = feed.channel;

  console.log(`\n${c.title}`);
  console.log(`  podcast:guid   ${c.podcastGuid ?? '(none — one should be generated on import)'}`);
  console.log(`  locked         ${c.podcastLocked === null ? '(not set)' : c.podcastLocked ? 'YES' : 'no'}`);
  console.log(`  episodes       ${feed.items.length}`);

  const counts = new Map<string, number>();
  const tally = (names: string[]) => names.forEach((n) => counts.set(n, (counts.get(n) ?? 0) + 1));
  tally(c.extra.map((n) => n.name));
  feed.items.forEach((it) => tally(it.extra.map((n) => n.name)));
  if (counts.size) {
    console.log('\nPreserved tags (beyond the typed fields):');
    [...counts].sort((a, b) => b[1] - a[1]).forEach(([n, k]) => console.log(`  ${String(k).padStart(5)}  ${n}`));
  }

  if (detectedPrefixes.length) console.log(`\nStats prefixes found (stripped, offered as settings): ${detectedPrefixes.map((p) => p.serviceKey + (p.paramValue ? `=${p.paramValue}` : '')).join(' → ')}`);
  if (removedPrefixes.length) console.log(`Defunct prefixes removed: ${removedPrefixes.join(', ')}`);

  const refs = collectMediaRefs(feed);
  const byKind = new Map<string, number>();
  refs.forEach((r) => byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1));
  console.log(`\nFiles to copy: ${[...byKind].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`);

  if (warnings.length) {
    console.log(`\nWarnings (${warnings.length}):`);
    warnings.slice(0, 20).forEach((w) => console.log(`  ! ${w}`));
  }

  const keys = (arg('--prefix') ?? '').split(',').filter(Boolean);
  const settings: PrefixSetting[] = keys.map((k, i) => {
    const [serviceKey, paramValue] = k.split('=');
    return { serviceKey: serviceKey!, paramValue, enabled: true, position: i };
  });
  const out = arg('--out') ?? 'rebuilt.xml';
  await writeFile(out, buildFeed(feed, { prefixChain: buildPrefixChain(settings) }));
  console.log(`\nRebuilt feed written to ${out}`);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
