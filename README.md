# podcast-feed-import-and-host

Self-hosted podcast feed host. It imports an existing podcast RSS feed, replicates it with full iTunes and Podcasting 2.0 tag support, and serves it from your own server (Ubuntu Server). Each podcaster has their own login and can only see their own shows.

## Status

- [x] Feed parser and builder (lossless round trip of all tags)
- [x] Stats prefixes (OP3, Podtrac, Podscribe, Magellan AI, Blubrry, custom), with detection on import
- [x] PostgreSQL schema
- [x] Import worker (media download and URL rewrite, resumable, SSRF-guarded)
- [x] Accounts, sessions and per-user access (owner, editor and viewer roles)
- [x] JSON API and public feed endpoint
- [ ] Web dashboard
- [ ] Podcast ownership verification on import
- [ ] Docker and Nginx deployment

See [`server/README.md`](server/README.md) for setup and details.
