# Roadmap

What's planned next, roughly in order. For what's already built, see the feature list in the [README](README.md).

Found a bug or want to help? [Open an issue](https://github.com/rgblack316/podsovereign/issues) or send a pull request.

## Audio and AI tools (to research before building)

Optional helpers for publishing an episode, each using an outside service with its own API key (set in Site settings). Details, services and costs to be researched when it's time to build.
- [ ] **Transcription:** transcribe uploaded episodes with OpenAI Whisper or another AI transcription service, saved as the episode's `podcast:transcript` (SRT/VTT)
- [ ] **AI show notes, titles and chapters:** (Auphonic users can already have Auphonic write show notes and chapters; this item is for shows without it) suggest show notes, title ideas and chapter markers from the transcript, for the podcaster to review and edit before publishing (chapters saved as `podcast:chapters`)
- [x] **Auphonic processing:** per show, send new uploads through the show's Auphonic preset with the episode's title, number, author, podcast name, owner, year, artwork and chapters (from the chapter editor, or let Auphonic create them), and optionally have Auphonic write the show notes; the 128 kbps stereo MP3 and transcripts (SRT, VTT, JSON, TXT) replace the upload, and the episode publishes when processing finishes. See [docs/auphonic.md](docs/auphonic.md)

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
- [x] Chapter editor in the dashboard (JSON, Audacity labels or .txt import, chapters read from and written into MP3 ID3 tags)

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
- [ ] Storage limits per account or per show (usage is shown already: Site settings → Storage used)

## Installs and updates
- [ ] Commit a `package-lock.json` so every Docker build uses the same dependency versions
- [ ] Publish a prebuilt app image on GitHub Container Registry, so installs and updates skip the local build (seconds instead of minutes)

## Recently completed
- Auphonic processing per show: your preset plus the episode's details, 128 kbps stereo MP3, transcripts (SRT, VTT, JSON, TXT), chapters and show notes from Auphonic if wanted, publish when processing finishes, reprocess from the kept original
- Chapter editor: JSON, Audacity labels or .txt import, chapters read from and written into MP3 ID3 tags, images and hidden markers
- Old feed redirects re-checked weekly after the move, with a warning if one stops working; the status bar drops the redirect light once the move is settled
- Storage used: per show (the show's status bar), and per account and for the whole site (Site settings)
- Website rebuild on feed changes (Cloudflare Pages, Netlify, Vercel, Render, GitHub Actions, custom webhook)
- OP3 Stats tab for shows using the OP3 prefix: daily downloads (30 days, 90 days, a year), countries, apps, per-episode downloads in the Episodes list and editor
- Saved passwords and API keys encrypted in the database; the dashboard font is served from your own server (no Google Fonts)
- Database backups from the admin panel: instant download, scheduled backups by email or to any storage provider, optional encryption
- Forms for value, funding, podroll, update frequency, license and text records; people and locations
- Show page tabs: Overview (hides 7 days after setup), Show details, Episodes (with live shows), Settings (Podping, stats prefixes, team)
- Episode list paging (10, 25, 50 or all)
- Podping through the Podcast Index hub, no key needed
- Show teams (owners, editors, viewers) and account deletion
- Publishing: new shows, new and edited episodes, resumable uploads
- Password reset command
- Docker Compose deployment with one-line install and update scripts
