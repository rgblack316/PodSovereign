# PodSovereign

**Your podcast. Your platform. Your rules.**

Self-hosted podcast hosting. Import an existing podcast's RSS feed, or start a new show, and serve it from your own server with full iTunes and Podcasting 2.0 tag support. Each podcaster has their own login and sees only their own shows and the shows they've been added to.

Clone it and run your own: the site's name, logo, favicon and web address are all set from the admin panel.

## Features

**Moving a show here**
- Import from any RSS feed, with ownership verification (a `podcast:txt` tag or a code emailed to the feed's owner; admins can skip it)
- Every file is copied: audio, video, artwork, transcripts, chapters, people images, and images inside show notes and chapter files
- Lossless: every tag round-trips, including ones the app doesn't know
- A move checklist: media copied, a check that the old host's 301 redirect is in place, then Podping

**Publishing**
- Start new shows; publish, schedule or draft episodes; edit any episode, imported or new
- Resumable uploads for audio, video, artwork, transcripts and chapters (large files are fine, even through Cloudflare Tunnel)
- Episode length and artwork size read from the files; an Apple Podcasts / Spotify readiness checklist
- Forms for Podcasting 2.0 tags: people, locations (with map lookup), value for value (Lightning splits, per show or episode), support links, recommended shows (podroll), schedule, license, text records. Anything else is editable as XML
- Live shows (`podcast:liveItem`): schedule, go live, end
- Stats prefixes (OP3, Podtrac, Podscribe, Magellan AI, Blubrry, custom), detected on import
- OP3 Stats tab for shows using the OP3 prefix: all-time downloads (from the show's whole OP3 history, re-read monthly to pick up OP3's corrections), daily downloads over 30 days, 90 days or a year, countries, apps, and per-episode downloads (also in the Episodes list and editor). Add an OP3 API token under Site settings. Numbers are fetched from OP3 every 6 hours and saved, so the tab opens instantly.
- Podping through the Podcast Index hub (no key needed), with a switch per show

**Running it**
- Show teams: owner, editors and viewers; hand ownership over
- Admin panel: site name, logo, favicon, web and media address (links rewritten and old addresses redirected), sign-ups, email (Resend or SMTP), people and administrators
- Media on this server or a storage provider: Cloudflare R2 is in production use; Backblaze B2, Amazon S3, Wasabi, DigitalOcean Spaces, Bunny and other S3-compatible services are available but untested (see [Reporting problems](#reporting-problems))
- Database backups from the admin panel: download one right away, or send them automatically (daily or weekly) by email and/or to any of the storage providers (R2, B2, S3, Wasabi, Spaces, Bunny or other S3-compatible), optionally encrypted
- Docker Compose, a one-line installer, an update script with automatic database backups, and an optional Cloudflare Tunnel container

Built with Node.js 22 and PostgreSQL 16; the dashboard is plain JavaScript with no build step.

PodSovereign was called FeedHost early on. A few internal names still use `feedhost` (the Docker project, the database, and the `FEEDHOST_*` settings in `.env`) so existing installs keep working through updates; leave them as they are.

## Install

On a fresh Ubuntu Server (22.04 or newer) or Debian machine, paste this into the terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/rgblack316/podsovereign/main/install.sh | sudo bash
```

It installs Docker if needed, downloads PodSovereign to `/opt/podsovereign`, asks for your web address, port and (optionally) a Cloudflare Tunnel token, generates a database password and starts everything. Then open the site and create the first account; it becomes the admin.

For an unattended install, give the answers up front:

```bash
curl -fsSL https://raw.githubusercontent.com/rgblack316/podsovereign/main/install.sh \
  | sudo PODSOVEREIGN_NONINTERACTIVE=1 PODSOVEREIGN_URL=https://podcasts.example.com PODSOVEREIGN_TUNNEL_TOKEN=eyJ... bash
```

## Update

Installs from before the rename to PodSovereign live in `/opt/feedhost` instead of `/opt/podsovereign`; use that folder in the commands below. Everything else is the same, and updating keeps all your shows and settings.

```bash
cd /opt/podsovereign && sudo ./update.sh
```

It shows what's new, backs up the database to `backups/` (the last 10 are kept), downloads the new version, rebuilds and restarts. Database changes apply automatically on start. `upgrade.sh` does the same thing. Options: `--check` (only show what's new), `--yes` (don't ask), `--no-backup`, `--force` (rebuild even if nothing changed). If the app doesn't come back, the script prints the exact commands to return to the previous version.

## Backups and restore

A backup is the database: shows, episodes, tags, accounts and settings. Media files aren't in it; they stay in your media storage (`/opt/podsovereign/data` when stored on this server, or your storage bucket).

**From the admin panel** (Site settings → Backups):
- **Download a backup now** builds a fresh one and saves it to your computer.
- **Automatic backups** run daily or weekly at the time and time zone you pick, and go to email (every administrator, or one address you choose; up to 18 MB), to a bucket at any of the same storage providers offered for media (the newest 14 are kept by default), or both. Use a separate, private bucket from your media; backups are never uploaded as public files. **Test connection** checks the bucket before you save, and **Send a backup now** sends one right away. Recent results show under the settings.
- **Encryption:** set a passphrase (at least 12 characters) and emailed and uploaded backups are encrypted; downloads can be too. Keep the passphrase somewhere safe: without it, an encrypted backup can't be restored.

Backup files are named `podsovereign-db-<date>-<time>.sql.gz` (UTC), plus `.enc` when encrypted.

**From the server:** `update.sh` saves one to `backups/` before every update. To make one by hand:
`cd /opt/podsovereign && sudo docker compose exec -T db pg_dump -U feedhost -d feedhost --clean --if-exists | gzip > backups/manual.sql.gz`

**Restore** (this replaces what's in the database now):
1. If the backup is encrypted, decrypt it first (it asks for the passphrase):
   `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in podsovereign-db-….sql.gz.enc -out backup.sql.gz`
2. Copy the `.sql.gz` to the server, then:
   `cd /opt/podsovereign && gunzip -c backup.sql.gz | sudo docker compose exec -T db psql -U feedhost -d feedhost`
3. `sudo docker compose restart app`

Keep copies of `/opt/podsovereign/.env` (the database password and settings) and `/opt/podsovereign/data/secret.key` too.

**Saved passwords and API keys** (storage keys, the SMTP password, the Resend key, the backup passphrase) are encrypted in the database with the key in `data/secret.key`, which the app creates on first start. A database backup on its own can't reveal them. To restore onto another server, copy `secret.key` into its `data/` folder before starting the app; without it everything else restores, but you'll need to enter those keys again in Site settings. (Advanced: set `SECRET_KEY` in `.env` to keep the key there instead; it must stay the same once set.)

## Day to day (in `/opt/podsovereign`)

| | |
|---|---|
| Follow the log | `sudo docker compose logs -f app` |
| Restart | `sudo docker compose restart app` |
| Stop / start | `sudo docker compose down` / `sudo docker compose up -d` |
| Status | `sudo docker compose ps` |
| Reset a forgotten password | `sudo docker compose exec app node --import tsx src/cli/reset-password.ts [email]` |

The app listens only on `127.0.0.1` (port 8080 by default). A Cloudflare Tunnel (run by Docker when you give a token, or installed separately) or any reverse proxy on the same machine makes it public.

## Forgot a password

Passwords are stored as one-way hashes, so they can't be looked up, only replaced. On the server:

```bash
cd /opt/podsovereign && sudo docker compose exec app node --import tsx src/cli/reset-password.ts
```

With no email it resets the only admin account (with more than one, it lists the accounts so you can name one). It prints a new random password and signs that account out everywhere. Sign in with it, then choose your own under **Account**.

## Addresses

Each show's feed is at `https://<your web address>/<show>/feed.xml`, with its media under `/<show>/media/` (or at your storage provider's address). For example, `https://podcasts.johnscreekstudios.com/<show>/feed.xml`, served through a Cloudflare Tunnel with media on Cloudflare R2.

The first install builds the app image on your server, downloading Node.js and npm packages at that point.

## More

- [`server/README.md`](server/README.md): settings, the Cloudflare Tunnel guide, media storage providers, publishing, Podping, the API and how it all works
- [`ROADMAP.md`](ROADMAP.md): what's planned next

## Reporting problems

Found a bug, or tried a storage provider that doesn't work? Please [open an issue](https://github.com/rgblack316/podsovereign/issues) describing what happened, or send a pull request with a fix.

## License

Copyright (C) 2026 Randall Black

PodSovereign is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

In short: you can use, change and share it freely. If you run a modified version as a service for other people, you must offer them the source code of your version under the same license. The dashboard links to the source for this reason.

The dashboard font, Archivo, is under the SIL Open Font License (`server/web/ARCHIVO-OFL.txt`).
