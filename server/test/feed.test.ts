import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PrefixError,
  applyPrefixes,
  buildFeed,
  buildPrefixChain,
  collectMediaRefs,
  detectPrefixes,
  parseFeed,
  type XmlNode,
} from '../src/feed/index.js';
import { chapterImageUrls, htmlImageUrls, rewriteChapterImages, rewriteHtmlImages } from '../src/feed/media.js';
import { parseXml } from '../src/feed/xml.js';

const FIXTURE = readFileSync(new URL('./fixtures/full-feed.xml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-19T16:00:00Z');
const find = (nodes: XmlNode[], name: string) => nodes.filter((n) => n.name === name);

// ───────────── Parsing ─────────────

test('parses typed channel fields', () => {
  const { feed, warnings } = parseFeed(FIXTURE);
  const c = feed.channel;
  assert.equal(c.title, 'The Test Show & Friends');
  assert.equal(c.description, '<p>A show about <strong>testing</strong> feeds.</p>');
  assert.equal(c.imageUrl, 'https://oldhost.example.com/art-3000.jpg', 'prefers itunes:image over rss image');
  assert.equal(c.itunesOwnerEmail, 'owner@example.com');
  assert.deepEqual(c.itunesCategories, [
    { text: 'Technology', sub: [] },
    { text: 'Society & Culture', sub: ['Documentary'] },
  ]);
  assert.equal(c.itunesExplicit, false);
  assert.equal(c.podcastGuid, '917393e3-1b1e-5cef-ace4-edaa54e1f810');
  assert.equal(c.podcastLocked, false);
  assert.equal(c.podcastLockedOwner, 'owner@example.com');
  assert.equal(c.podcastMedium, 'podcast');
  assert.deepEqual(warnings.filter((w) => !w.includes('no <guid>')), []);
});

test('keeps every other tag (incl. unknown namespaces) in channel.extra, in order', () => {
  const { feed } = parseFeed(FIXTURE);
  const names = feed.channel.extra.map((n) => n.name);
  assert.deepEqual(names, [
    'itunes:summary',
    'googleplay:block',
    'podcast:funding',
    'podcast:location',
    'podcast:license',
    'podcast:txt',
    'podcast:updateFrequency',
    'podcast:trailer',
    'podcast:person',
    'podcast:value',
    'podcast:podroll',
    'podcast:liveItem',
    'fh:customThing',
  ]);
  const value = find(feed.channel.extra, 'podcast:value')[0]!;
  assert.equal(value.children.length, 2);
  assert.equal(value.children[1]!.attrs.fee, 'true');
  assert.deepEqual(feed.namespaces, { fh: 'https://example.com/ns/custom' });
});

test('drops old-host self/hub links and regenerated tags', () => {
  const { feed } = parseFeed(FIXTURE);
  const names = feed.channel.extra.map((n) => n.name);
  for (const gone of ['atom:link', 'lastBuildDate', 'generator', 'image']) assert.ok(!names.includes(gone), gone);
});

test('parses items: typed fields, durations, explicit variants', () => {
  const { feed } = parseFeed(FIXTURE);
  const [ep2, ep1] = feed.items;
  assert.equal(ep2!.guid, 'ep-0002');
  assert.equal(ep2!.guidIsPermalink, false);
  assert.equal(ep2!.itunesDuration, 3723);
  assert.equal(ep2!.itunesExplicit, false);
  assert.equal(ep2!.pubDate!.toISOString(), '2026-10-12T10:00:00.000Z');
  assert.equal(ep2!.extra.filter((n) => n.name === 'podcast:transcript').length, 2);
  assert.equal(ep1!.itunesDuration, 3600);
  assert.equal(ep1!.itunesExplicit, true);
  assert.equal(ep1!.itunesEpisodeType, 'trailer');
});

test('missing guid falls back to the original enclosure URL', () => {
  const { feed, warnings } = parseFeed(FIXTURE);
  assert.equal(feed.items[1]!.guid, 'https://oldhost.example.com/media/ep1.m4a');
  assert.ok(warnings.some((w) => w.includes('Episode 1')));
});

test('strips existing prefixes on import and reports them', () => {
  const { feed, detectedPrefixes, removedPrefixes } = parseFeed(FIXTURE);
  assert.equal(feed.items[0]!.enclosureUrl, 'https://oldhost.example.com/media/ep2.mp3');
  assert.deepEqual(
    detectedPrefixes.map((p) => [p.serviceKey, p.position]),
    [['op3', 0], ['podtrac', 1]],
  );
  assert.deepEqual(removedPrefixes, ['https://chtbl.com/track/ABC123/']);
});

test('warns when the source feed is locked', () => {
  const locked = FIXTURE.replace('owner="owner@example.com">no<', 'owner="owner@example.com">yes<');
  const { warnings } = parseFeed(locked);
  assert.ok(warnings.some((w) => w.includes('unlock')));
});

test('normalises non-standard namespace prefixes', () => {
  const xml = `<rss version="2.0" xmlns:pi="https://podcastindex.org/namespace/1.0" xmlns:it="http://www.itunes.com/dtds/podcast-1.0.dtd">
    <channel><title>X</title><pi:guid>abc</pi:guid><it:author>Me</it:author><pi:funding url="https://x.com/d">Fund</pi:funding></channel></rss>`;
  const { feed } = parseFeed(xml);
  assert.equal(feed.channel.podcastGuid, 'abc');
  assert.equal(feed.channel.itunesAuthor, 'Me');
  assert.equal(feed.channel.extra[0]!.name, 'podcast:funding');
});

test('rejects non-RSS documents', () => {
  assert.throws(() => parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), /Expected an RSS feed/);
});

// ───────────── Building ─────────────

test('round trip: parse → build → parse gives an identical model', () => {
  const first = parseFeed(FIXTURE).feed;
  const xml = buildFeed(first, { selfUrl: 'https://feeds.mine.example/test.xml', now: NOW });
  const again = parseFeed(xml);
  assert.deepEqual(again.feed, first);
  assert.deepEqual(again.warnings.filter((w) => !w.includes('no <guid>')), []);
});

test('round trip is stable with prefixes enabled (they are stripped again on re-import)', () => {
  const first = parseFeed(FIXTURE).feed;
  const chain = buildPrefixChain([
    { serviceKey: 'podtrac', enabled: true, position: 1 },
    { serviceKey: 'op3', enabled: true, position: 0 },
  ]);
  const xml = buildFeed(first, { prefixChain: chain, now: NOW });
  const again = parseFeed(xml);
  assert.deepEqual(again.feed, first);
  assert.deepEqual(again.detectedPrefixes.map((p) => p.serviceKey), ['op3', 'podtrac']);
});

test('built feed is well-formed and declares namespaces', () => {
  const xml = buildFeed(parseFeed(FIXTURE).feed, { selfUrl: 'https://feeds.mine.example/test.xml', now: NOW });
  const { root, warnings } = parseXml(xml);
  assert.deepEqual(warnings, []);
  for (const ns of ['itunes', 'podcast', 'content', 'atom', 'googleplay', 'fh']) assert.ok(xml.includes(`xmlns:${ns}=`), ns);
  assert.ok(xml.includes('<atom:link href="https://feeds.mine.example/test.xml" rel="self"'));
  assert.ok(!xml.includes('oldhost.example.com/feed.xml'));
  assert.equal(root.children[0]!.children.filter((n) => n.name === 'item').length, 2);
  assert.ok(xml.includes('<description><![CDATA[<p>Show notes'), 'HTML notes use CDATA');
  assert.ok(xml.includes('<description>Plain notes, no markup.</description>'), 'plain notes are not wrapped');
});

test('enclosures get the prefix chain; alternate enclosures only when asked', () => {
  const feed = parseFeed(FIXTURE).feed;
  const chain = buildPrefixChain([
    { serviceKey: 'op3', enabled: true, position: 0 },
    { serviceKey: 'podtrac', enabled: true, position: 1 },
    { serviceKey: 'podscribe', enabled: false, position: 2 },
  ]);
  const xml = buildFeed(feed, { prefixChain: chain, now: NOW });
  assert.ok(xml.includes('url="https://op3.dev/e/dts.podtrac.com/redirect.mp3/oldhost.example.com/media/ep2.mp3"'));
  assert.ok(xml.includes('uri="https://oldhost.example.com/media/ep2.mp4"'));
  const xml2 = buildFeed(feed, { prefixChain: chain, prefixAlternateEnclosures: true, now: NOW });
  assert.ok(xml2.includes('uri="https://op3.dev/e/dts.podtrac.com/redirect.mp3/oldhost.example.com/media/ep2.mp4"'));
  assert.ok(xml2.includes('uri="ipfs://'), 'non-http sources untouched');
});

test('hides drafts and future-scheduled episodes', () => {
  const feed = parseFeed(FIXTURE).feed;
  feed.items[0]!.status = 'draft';
  feed.items[1]!.status = 'scheduled';
  feed.items[1]!.pubDate = new Date('2026-12-01T00:00:00Z');
  assert.ok(!buildFeed(feed, { now: NOW }).includes('<item>'));
  assert.equal((buildFeed(feed, { now: NOW, publishedOnly: false }).match(/<item>/g) ?? []).length, 2);
});

test('escapes and strips illegal characters', () => {
  const feed = parseFeed(FIXTURE).feed;
  feed.items[1]!.title = 'Tom & Jerry <live>\u0007';
  const xml = buildFeed(feed, { now: NOW });
  assert.ok(xml.includes('<title>Tom &amp; Jerry &lt;live&gt;</title>'));
  feed.items[0]!.description = 'Tricky ]]> sequence <b>bold</b>';
  const reparsed = parseFeed(buildFeed(feed, { now: NOW })).feed;
  assert.equal(reparsed.items[0]!.description, 'Tricky ]]> sequence <b>bold</b>');
});

// ───────────── Prefixes ─────────────

test('applyPrefixes chains outermost first and strips inner schemes', () => {
  const chain = ['https://op3.dev/e/', 'https://pscrb.fm/rss/p/'];
  assert.equal(applyPrefixes('https://host.com/a.mp3', chain), 'https://op3.dev/e/pscrb.fm/rss/p/host.com/a.mp3');
  assert.equal(applyPrefixes('https://host.com/a.mp3', []), 'https://host.com/a.mp3');
});

test('services with parameters are validated', () => {
  assert.deepEqual(buildPrefixChain([{ serviceKey: 'magellan', enabled: true, paramValue: 'abc123', position: 0 }]), [
    'https://mgln.ai/e/abc123/',
  ]);
  assert.deepEqual(buildPrefixChain([{ serviceKey: 'blubrry', enabled: true, paramValue: 'myshow', position: 0 }]), [
    'https://media.blubrry.com/myshow/',
  ]);
  assert.throws(() => buildPrefixChain([{ serviceKey: 'magellan', enabled: true, position: 0 }]), PrefixError);
  assert.throws(
    () => buildPrefixChain([{ serviceKey: 'blubrry', enabled: true, paramValue: 'bad/slug', position: 0 }]),
    PrefixError,
  );
  // Disabled services aren't validated (checkbox off, field may be empty).
  assert.deepEqual(buildPrefixChain([{ serviceKey: 'magellan', enabled: false, position: 0 }]), []);
});

test('custom prefixes must be https URLs and get a trailing slash', () => {
  assert.deepEqual(
    buildPrefixChain([{ serviceKey: 'custom', enabled: true, paramValue: 'https://track.example.com/p', position: 0 }]),
    ['https://track.example.com/p/'],
  );
  for (const bad of ['http://x.com/', 'not a url', 'https://x.com/?a=1']) {
    assert.throws(
      () => buildPrefixChain([{ serviceKey: 'custom', enabled: true, paramValue: bad, position: 0 }]),
      PrefixError,
      bad,
    );
  }
});

test('detectPrefixes handles each built-in service', () => {
  const cases: [string, string, string | null][] = [
    ['https://op3.dev/e/host.com/a.mp3', 'op3', null],
    ['https://op3.dev/e,pg=917393e3/host.com/a.mp3', 'op3', null],
    ['https://dts.podtrac.com/redirect.m4a/host.com/a.m4a', 'podtrac', null],
    ['https://www.podtrac.com/pts/redirect.mp3/host.com/a.mp3', 'podtrac', null],
    ['https://pscrb.fm/rss/p/host.com/a.mp3', 'podscribe', null],
    ['https://mgln.ai/e/xyz9/host.com/a.mp3', 'magellan', 'xyz9'],
    ['https://media.blubrry.com/myshow/host.com/a.mp3', 'blubrry', 'myshow'],
    ['https://pdst.fm/e/host.com/a.mp3', 'custom', 'https://pdst.fm/e/'],
  ];
  for (const [url, key, param] of cases) {
    const r = detectPrefixes(url);
    assert.equal(r.cleanUrl, 'https://host.com/' + url.split('/').pop(), url);
    assert.equal(r.detected[0]!.serviceKey, key, url);
    assert.equal(r.detected[0]!.paramValue ?? null, param, url);
  }
});

test('detectPrefixes leaves look-alike URLs alone', () => {
  // Blubrry-hosted file, not a prefix: what follows isn't a hostname.
  const u = 'https://media.blubrry.com/myshow/episode1.mp3';
  assert.deepEqual(detectPrefixes(u), { cleanUrl: u, detected: [], removed: [] });
  const plain = 'https://host.com/op3.dev/e/x.mp3';
  assert.equal(detectPrefixes(plain).cleanUrl, plain);
});

// ───────────── Media references ─────────────

test('collects downloadable media and can rewrite it', () => {
  const { feed } = parseFeed(FIXTURE);
  const refs = collectMediaRefs(feed);
  const summary = refs.map((r) => `${r.kind} ${r.where}`);
  assert.ok(summary.includes('image channel image'));
  assert.ok(summary.includes('audio channel podcast:trailer'));
  assert.ok(summary.includes('image channel podcast:person'));
  assert.ok(summary.includes('audio item[0] enclosure'));
  assert.ok(summary.includes('transcript item[0] podcast:transcript'));
  assert.ok(summary.includes('chapters item[0] podcast:chapters'));
  assert.ok(summary.includes('video item[0] podcast:source'));
  assert.ok(!refs.some((r) => r.url.includes('stream.example.com')), 'live streams are never downloaded');
  assert.ok(!refs.some((r) => r.url.startsWith('ipfs:')));

  for (const r of refs) r.set(r.url.replace('https://oldhost.example.com/', 'https://mine.example/media/test/'));
  const xml = buildFeed(feed, { now: NOW });
  // Only the fallback GUID still mentions the old host — GUIDs must never change.
  const leftovers = xml.split('\n').filter((l) => l.includes('oldhost.example.com'));
  assert.deepEqual(leftovers.map((l) => l.trim()), ['<guid>https://oldhost.example.com/media/ep1.m4a</guid>']);
  assert.ok(xml.includes('srcset="https://mine.example/media/test/ep2-1500.jpg 1500w, https://mine.example/media/test/ep2-600.jpg 600w"'));
});

test('finds and rewrites show-notes images, decoding entities, and only inside <img>/<source>', () => {
  const html =
    '<p><img src="https://a.com/x.jpg?w=1&amp;h=2" alt="A"> <a href="https://a.com/x.jpg?w=1&amp;h=2">link</a>' +
    "<IMG SRC='https://a.com/y.png'><source srcset=\"https://a.com/s1.webp 1x, https://a.com/s2.webp 2x\"></p>";
  assert.deepEqual(htmlImageUrls(html), [
    'https://a.com/x.jpg?w=1&h=2',
    'https://a.com/y.png',
    'https://a.com/s1.webp',
    'https://a.com/s2.webp',
  ]);
  const out = rewriteHtmlImages(html, (u) => (u.startsWith('https://a.com/') ? u.replace('https://a.com/', 'https://me/') : undefined));
  assert.ok(out.includes('<img src="https://me/x.jpg?w=1&amp;h=2" alt="A">'));
  assert.ok(out.includes('<a href="https://a.com/x.jpg?w=1&amp;h=2">'), 'links untouched');
  assert.ok(out.includes('SRC="https://me/y.png"'));
  assert.ok(out.includes('srcset="https://me/s1.webp 1x, https://me/s2.webp 2x"'));
  assert.equal(rewriteHtmlImages(html, () => undefined), html, 'no-op leaves HTML byte-identical');
});

test('chapter image helpers', () => {
  const doc = { version: '1.2.0', chapters: [{ startTime: 0, img: 'https://a.com/1.jpg' }, { startTime: 5 }, { img: 'rel.jpg' }] };
  assert.deepEqual(chapterImageUrls(doc), ['https://a.com/1.jpg']);
  const out = rewriteChapterImages(doc, () => 'https://me/1.jpg') as typeof doc;
  assert.equal(out.chapters[0]!.img, 'https://me/1.jpg');
  assert.equal(doc.chapters[0]!.img, 'https://a.com/1.jpg', 'original not mutated');
  assert.deepEqual(chapterImageUrls({ nope: true }), []);
});
