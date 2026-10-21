# Roadmap

## Media on a CDN instead of the Cloudflare Tunnel

**Status:** built. Choose a provider under Site settings → Media storage.
- [x] Cloudflare R2: in production use for John's Creek Studios
- [ ] Backblaze B2, Amazon S3, Wasabi, DigitalOcean Spaces, Bunny Storage, other S3-compatible: **available but untested with real accounts** (marked "Not yet tested" in Site settings). Anyone who tries one and runs into trouble can [open an issue](https://github.com/rgblack316/podcast-feed-import-and-host/issues) describing the problem for us to investigate, or submit a pull request with a fix.
- [ ] Optional: copy files to the provider directly from the old host, without staging on this server first (saves disk space during large imports)

Background: Cloudflare's terms restrict serving video, or a disproportionate amount of large files, through its CDN and Tunnel hostnames on Free, Pro and Business plans ([policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)), and every uncached download through the tunnel uses the home connection's upload bandwidth.

## OP3 stats on the show dashboard

Shown only for shows that have **OP3** ticked as a stats prefix (Settings → Stats prefixes); other shows see nothing new.
- [ ] A Stats panel on the show page: downloads over time (last 7 / 30 / 90 days), top episodes, and top apps and countries
- [ ] Per-episode download counts in the Episodes list and the episode editor
- [ ] Find the show on OP3 by its `podcast:guid` (no setup for the podcaster), with a link to its public OP3 stats page
- [ ] OP3 API key in Site settings (to confirm against OP3's API docs when building), with results cached so the dashboard doesn't call OP3 on every page view
- [ ] Note in the panel that stats count from when the OP3 prefix was turned on

## Live shows (`podcast:liveItem`)

Done:
- [x] Create, edit and delete live items: title, times, stream URL, image, content links
- [x] Status changes pending → live → ended, each announced through Podping (Podcast Index hub)

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
- [ ] Encrypt saved secrets at rest: storage provider keys, SMTP password, Resend key (today they're stored in the database as-is)
- [ ] Storage quotas per account or per podcast, with a usage display
- [x] Forms for Podcasting 2.0 tags: people, locations, value (show and episode, with time splits kept), funding, podroll (with feed lookup), updateFrequency, license, txt
- [ ] Still edited as XML under *Other tags*, possible future forms:
  - [ ] `podcast:image`: artwork in several sizes, generated from the uploaded show and episode art (single artwork for now)
  - [ ] `podcast:soundbite`: start/duration/title per episode
- [ ] Waveform or chapter editor in the dashboard (today chapters are uploaded as a JSON file)
- [ ] Commit a `package-lock.json` so Docker builds use pinned dependency versions
- [ ] Prebuilt app image on GitHub Container Registry, so installs and updates skip the local build
