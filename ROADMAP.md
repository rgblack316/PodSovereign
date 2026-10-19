# Roadmap

## Media on a CDN instead of the Cloudflare Tunnel

**Status:** built. Choose a provider under Site settings → Media storage. Still to do after testing with real shows:
- [ ] Try each provider with a real account: R2, B2, S3, Wasabi, Spaces, Bunny
- [ ] Decide which to use for John's Creek Studios. R2 has no egress fees and sits on the same Cloudflare account as the tunnel.
- [ ] Optional: copy files to the provider directly from the old host, without staging on this server first (saves disk space during large imports)

Background: Cloudflare's terms restrict serving video, or a disproportionate amount of large files, through its CDN and Tunnel hostnames on Free, Pro and Business plans ([policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)), and every uncached download through the tunnel uses the home connection's upload bandwidth.

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
- [ ] Encrypt saved provider secrets and the Podping key at rest (today they're stored in the database as-is)
- [ ] Storage quotas per account or per podcast, with a usage display
- [ ] Episode editing and new uploads (beyond import)
- [ ] Commit a `package-lock.json` so Docker builds use pinned dependency versions
- [ ] Prebuilt app image on GitHub Container Registry, so installs and updates skip the local build
