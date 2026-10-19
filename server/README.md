# FeedHost — server

Core feed engine for importing, replicating and hosting a podcast RSS feed with full iTunes and Podcasting 2.0 support.

## Setup (Ubuntu Server)

```bash
# Node 22+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

npm install
npm test           # 21 tests: parsing, round trip, prefixes, media
npm run typecheck
```

## Try it on a real feed

```bash
npm run preview -- https://yourhost.com/feed.xml
npm run preview -- https://yourhost.com/feed.xml --prefix op3,podtrac --out rebuilt.xml
npm run preview -- feed.xml --prefix op3,magellan=YOURID,blubrry=yourshow
```

This prints the preserved tags, any stats prefixes found, the files that would be copied and any warnings, then writes the regenerated feed.

## Layout

| File | Purpose |
|---|---|
| `src/feed/xml.ts` | XML → tree (normalises namespace prefixes), escaping, CDATA, serialiser |
| `src/feed/parser.ts` | RSS → `Feed` model: typed fields plus `extra` for every other tag |
| `src/feed/builder.ts` | `Feed` → RSS: writes our own self link and dates, applies the prefix chain, hides drafts and future episodes |
| `src/feed/prefixes.ts` | Built-in stats services, validation, chaining, detection of existing prefixes on import |
| `src/feed/media.ts` | Finds every file to copy (enclosures, art, transcripts, chapters, people, srcset, trailers) and rewrites URLs |
| `src/db/migrations/001_schema.sql` | PostgreSQL schema |

## How it handles the tricky parts

- **No tag loss.** Anything without a typed field is stored as a raw node, in order and with nesting, and written back. This covers `podcast:value`, `podcast:liveItem`, `podcast:alternateEnclosure` and unknown namespaces.
- **GUIDs never change.** The channel `podcast:guid` and every episode `<guid>` are kept exactly as they were.
- **Prefixes.** Enclosure URLs are stored clean. Existing prefixes are stripped on import, which also keeps the import's own downloads from counting as listens, and are offered back as pre-checked settings. Chartable is removed because it shut down.
- **Locked feeds.** Importing a feed with `<podcast:locked>yes` produces a warning, because the old host must unlock it first.
- **Live streams.** URLs inside `podcast:liveItem` are never downloaded.
