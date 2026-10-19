# Roadmap

## Revisit after testing: serve media from a CDN instead of the Cloudflare Tunnel

**Status:** deferred until the tunnel setup has been tested with real shows.

**Why revisit**
- Cloudflare's terms restrict serving video, or a disproportionate amount of large files, through its CDN on Free, Pro and Business plans, and this covers Tunnel hostnames. Audio-only shows are probably fine at small scale; video episodes are not. ([Cloudflare policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/))
- Every uncached download comes from the home internet connection's upload bandwidth.

**Options to evaluate**
- **Cloudflare R2** behind a custom domain, such as `media.johnscreekstudios.com`. R2 has no egress fees.
- **Bunny CDN**, either with a storage zone or pulling from the tunnel origin.
- **Backblaze B2** in front of a CDN.

**Already prepared**
- `MEDIA_BASE_URL` sets the address used in media URLs, separately from the site.
- Media is already laid out as `<slug>/media/<type>/<file>`, so it can be copied to a bucket as-is.

**Still needed**
- Upload new media to the CDN or bucket during import, and sync existing files.
- A migration script that rewrites the stored media URLs from `PUBLIC_BASE_URL` to `MEDIA_BASE_URL`. URLs are stored as full URLs in episodes, tag attributes and chapter files.
- Keep the old `/<slug>/media/...` URLs working, for example with 301 redirects to the CDN, for apps that cached older feed copies.
- Re-check the stats prefixes (OP3, Podtrac and so on) against the new media host.

## Other open items
- [ ] Web dashboard: login, podcast list, import with live progress, and stats prefix checkboxes
- [ ] Podcast ownership verification on import (email code to the itunes:owner address, or a `podcast:txt` token)
- [ ] Storage quotas per account or per podcast, with a usage display
- [ ] Episode editing and new uploads (beyond import)
