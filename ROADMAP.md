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

## Live shows (`podcast:liveItem`)

Done:
- [x] Create, edit and delete live items: title, times, stream URL, image, content links
- [x] Status changes pending → live → ended, with Podping `live` and `liveEnd`

Possible next steps:
- [ ] Go live and end automatically at the scheduled times (optional, per live item)
- [ ] Turn an ended live item into a regular episode once the recording is uploaded
- [ ] Manage `podcast:chat` from the dashboard (imported chat tags are already kept)

## Potential future upgrade: built-in live streaming server

FeedHost doesn't stream today. Live items point at an outside stream (Icecast, YouTube, Twitch and so on). A built-in option could include:
- An audio streaming server (Icecast, or MediaMTX for audio and video), with stream keys per show
- Starting the stream from an encoder (OBS, Audio Hijack, Butt) that sets the live item to **live** automatically, and back to **ended** when it stops
- Recording the stream, then publishing the recording as an episode

**Hosting caveat:** Cloudflare's terms prohibit streaming video through its CDN and Tunnel hostnames on Free, Pro and Business plans, and restrict large-file traffic. A streaming server would need a different path, such as a separate DNS-only subdomain, Cloudflare Stream, or another provider. Weigh this together with the media CDN item above.

## Other open items
- [ ] Self-host the dashboard font instead of loading it from Google Fonts
- [ ] Podcast ownership verification on import (email code to the itunes:owner address, or a `podcast:txt` token)
- [ ] Storage quotas per account or per podcast, with a usage display
- [ ] Episode editing and new uploads (beyond import)
