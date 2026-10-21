# Roadmap

What's planned next, roughly in order. For what's already built, see the feature list in the [README](README.md).

Found a bug or want to help? [Open an issue](https://github.com/rgblack316/podsovereign/issues) or send a pull request.

## Next up: OP3 stats on the show dashboard

Shown only for shows that have **OP3** ticked as a stats prefix (Settings → Stats prefixes). Other shows see nothing new.
- [ ] A Stats panel on the show page: downloads over time (last 7 / 30 / 90 days), top episodes, and top apps and countries
- [ ] Per-episode download counts in the Episodes list and the episode editor
- [ ] Find the show on OP3 by its `podcast:guid` (no setup for the podcaster), with a link to its public OP3 stats page
- [ ] OP3 API key in Site settings (to confirm against OP3's API docs when building), with results cached so the dashboard doesn't call OP3 on every page view
- [ ] Note in the panel that stats count from when the OP3 prefix was turned on

## Media storage providers

Built: choose where media lives under Site settings → Media storage.
- [x] Cloudflare R2: in production use for John's Creek Studios
- [ ] Backblaze B2, Amazon S3, Wasabi, DigitalOcean Spaces, Bunny Storage and other S3-compatible services: **available but untested with real accounts** (marked "Not yet tested" in Site settings). If you try one and run into trouble, please [open an issue](https://github.com/rgblack316/podsovereign/issues) describing the problem (the Test connection results help) for us to investigate, or submit a pull request with a fix.
- [ ] Optional: copy files to the provider directly from the old host during an import, without staging them on this server first (saves disk space on large imports)

Background: Cloudflare's terms restrict serving video, or a disproportionate amount of large files, through its CDN and Tunnel hostnames on Free, Pro and Business plans ([policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)), and every uncached download through the tunnel uses the home connection's upload bandwidth. That's why media is best served from a storage provider such as R2.

## Podcasting 2.0 tags

Every tag already imports, round-trips and can be edited. Most have their own form; the rest are edited as XML under *More tags and options → Other tags*.
- [x] Forms: people, locations (with OpenStreetMap lookup), value (show and episode; time splits kept), funding, podroll (with feed lookup), update frequency, license, text records, transcripts, chapters
- [ ] `podcast:soundbite`: a form for each episode's highlight clips (start, duration, title)
- [ ] `podcast:image`: artwork in several sizes, generated from the uploaded show and episode art (one artwork for now)
- [ ] `podcast:chat`: manage the live chat link for live shows (imported chat tags are already kept)
- [ ] Chapter editor in the dashboard (today chapters are uploaded as a JSON file)

## Live shows

Built: schedule, start and end live shows from the Episodes tab; each change is announced through Podping.
- [ ] Go live and end automatically at the scheduled times (optional, per live show)
- [ ] Turn an ended live show into a regular episode once the recording is uploaded

### Possible future upgrade: built-in streaming server

PodSovereign doesn't stream today. Live shows point at an outside stream (Icecast, YouTube, Twitch and so on). A built-in option could include:
- An audio streaming server (Icecast, or MediaMTX for audio and video), with a stream key for each show
- Starting the stream from an encoder (OBS, Audio Hijack, Butt) sets the live show to **live** automatically, and back to **ended** when it stops
- Recording the stream, then publishing the recording as an episode

**Hosting caveat:** Cloudflare's terms prohibit streaming video through its CDN and Tunnel hostnames on Free, Pro and Business plans, and restrict large-file traffic. A streaming server would need a different path, such as a separate DNS-only subdomain, Cloudflare Stream, or another provider.

## Security and running costs
- [ ] Encrypt saved secrets at rest: storage provider keys, SMTP password, Resend key (today they're stored in the database as-is)
- [ ] Storage limits per account or per show, with a usage display
- [ ] Self-host the dashboard font instead of loading it from Google Fonts

## Installs and updates
- [ ] Commit a `package-lock.json` so every Docker build uses the same dependency versions
- [ ] Publish a prebuilt app image on GitHub Container Registry, so installs and updates skip the local build (seconds instead of minutes)

## Recently completed
- Database backups from the admin panel: instant download, scheduled backups by email or to any storage provider, optional encryption
- Forms for value, funding, podroll, update frequency, license and text records; people and locations
- Show page tabs: Overview (hides 7 days after setup), Show details, Episodes (with live shows), Settings (Podping, stats prefixes, team)
- Episode list paging (10, 25, 50 or all)
- Podping through the Podcast Index hub, no key needed
- Show teams (owners, editors, viewers) and account deletion
- Publishing: new shows, new and edited episodes, resumable uploads
- Password reset command
- Docker Compose deployment with one-line install and update scripts
