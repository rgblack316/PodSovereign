# podcast-feed-import-and-host

Self-hosted podcast feed host. It imports an existing podcast RSS feed, replicates it with full iTunes and Podcasting 2.0 tag support, and serves it from your own server (Ubuntu Server). Each podcaster has their own login and can only see their own shows.

Clone it and run your own: the site's name, logo, favicon and web address are all set from the admin panel.

## Status

- [x] Feed parser and builder (lossless round trip of all tags)
- [x] Stats prefixes (OP3, Podtrac, Podscribe, Magellan AI, Blubrry, custom), with detection on import
- [x] PostgreSQL schema
- [x] Import worker (media download and URL rewrite, resumable, SSRF-guarded)
- [x] Accounts, sessions and per-user access (owner, editor and viewer roles)
- [x] JSON API and public feed endpoint
- [x] Podping (per-show switch, off after import): scheduled episodes going live and stats prefix changes
- [x] Live show (`podcast:liveItem`) management: pending → live → ended, with live and liveEnd Podpings
- [x] Media storage on this server or a provider (R2, B2, S3, Wasabi, Spaces, Bunny, other S3) with connection test and background moves
- [x] Admin Site settings: name, logo, favicon, web and media address (stored links rewritten, old hostname redirected), sign-ups, Podping key
- [x] Web dashboard: shows, move checklist with 301 check, import progress, stats prefixes, Podping, live shows, people
- [x] Ownership verification on import: podcast:txt tag or a code emailed to the feed's owner (via Resend or SMTP), admin skip
- [ ] Docker and Nginx deployment

Planned public URLs: `https://podcasts.johnscreekstudios.com/<show>/feed.xml`, with media under `/<show>/media/`, served through a Cloudflare Tunnel.

See [`server/README.md`](server/README.md) for setup, including the Cloudflare Tunnel guide, and [`ROADMAP.md`](ROADMAP.md) for what's next, including the CDN revisit.
