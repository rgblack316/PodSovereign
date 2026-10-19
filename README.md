# podcast-feed-import-and-host

Self-hosted podcast feed host. It imports an existing podcast RSS feed, replicates it with full iTunes and Podcasting 2.0 tag support, and serves it from your own server (Ubuntu Server). Each podcaster has their own login and can only see their own shows.

## Status

- [x] Feed parser and builder (lossless round trip of all tags)
- [x] Stats prefixes (OP3, Podtrac, Podscribe, Magellan AI, Blubrry, custom), with detection on import
- [x] PostgreSQL schema
- [ ] Import worker (media download and URL rewrite)
- [ ] Auth and per-user access
- [ ] API and dashboard
- [ ] Docker and Nginx deployment

See [`server/README.md`](server/README.md) for setup and details.
