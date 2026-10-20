# podcast-feed-import-and-host

Self-hosted podcast feed host. It imports an existing podcast RSS feed (or starts a new show), replicates it with full iTunes and Podcasting 2.0 tag support, and serves it from your own server (Ubuntu Server). Each podcaster has their own login and can only see their own shows.

Clone it and run your own: the site's name, logo, favicon and web address are all set from the admin panel.

## Status

- [x] Feed parser and builder (lossless round trip of all tags)
- [x] Stats prefixes (OP3, Podtrac, Podscribe, Magellan AI, Blubrry, custom), with detection on import
- [x] PostgreSQL schema
- [x] Import worker (media download and URL rewrite, resumable, SSRF-guarded)
- [x] Accounts, sessions and per-user access: show teams (owner, editors, viewers, ownership hand-over), admin account management and deletion
- [x] JSON API and public feed endpoint
- [x] Podping (per-show switch, off after import): scheduled episodes going live and stats prefix changes
- [x] Live show (`podcast:liveItem`) management: pending → live → ended, with live and liveEnd Podpings
- [x] Media storage on this server or a provider (R2, B2, S3, Wasabi, Spaces, Bunny, other S3) with connection test and background moves
- [x] Admin Site settings: name, logo, favicon, web and media address (stored links rewritten, old hostname redirected), sign-ups, Podping key
- [x] Web dashboard: shows, move checklist with 301 check, import progress, stats prefixes, Podping, live shows, people
- [x] Ownership verification on import: podcast:txt tag or a code emailed to the feed's owner (via Resend or SMTP), admin skip
- [x] Publishing: start new shows, publish/schedule/edit episodes, resumable uploads (audio, art, transcripts, chapters), show details with an Apple/Spotify checklist
- [x] Docker Compose deployment with one-line install and update scripts (optional Cloudflare Tunnel container)

## Install

On a fresh Ubuntu Server (22.04 or newer) or Debian machine, paste this into the terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/rgblack316/podcast-feed-import-and-host/main/install.sh | sudo bash
```

It installs Docker if needed, downloads FeedHost to `/opt/feedhost`, asks for your web address, port and (optionally) a Cloudflare Tunnel token, generates a database password and starts everything. Then open the site and create the first account; it becomes the admin.

For an unattended install, give the answers up front:

```bash
curl -fsSL https://raw.githubusercontent.com/rgblack316/podcast-feed-import-and-host/main/install.sh \
  | sudo FEEDHOST_NONINTERACTIVE=1 FEEDHOST_URL=https://podcasts.example.com FEEDHOST_TUNNEL_TOKEN=eyJ... bash
```

## Update

```bash
cd /opt/feedhost && sudo ./update.sh
```

It shows what's new, backs up the database to `backups/` (the last 10 are kept), downloads the new version, rebuilds and restarts. Database changes apply automatically on start. `upgrade.sh` does the same thing. Options: `--check` (only show what's new), `--yes` (don't ask), `--no-backup`, `--force` (rebuild even if nothing changed). If the app doesn't come back, the script prints the exact commands to return to the previous version.

## Backups and restore

- **Media and logos:** `/opt/feedhost/data` (when stored on this server).
- **Database:** `update.sh` makes a backup each time. To make one by hand:
  `cd /opt/feedhost && sudo docker compose exec -T db pg_dump -U feedhost -d feedhost --clean --if-exists | gzip > backups/manual.sql.gz`
- **Restore:** `gunzip -c backups/<file>.sql.gz | sudo docker compose exec -T db psql -U feedhost -d feedhost`
- Keep a copy of `/opt/feedhost/.env` too; it holds the database password.

## Day to day (in `/opt/feedhost`)

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
cd /opt/feedhost && sudo docker compose exec app node --import tsx src/cli/reset-password.ts
```

With no email it resets the only admin account (with more than one, it lists the accounts so you can name one). It prints a new random password and signs that account out everywhere. Sign in with it, then choose your own under **Account**.

## URLs

Public URLs: `https://podcasts.johnscreekstudios.com/<show>/feed.xml`, with media under `/<show>/media/`, served through a Cloudflare Tunnel.

The first install builds the app image on your server; it downloads Node and npm packages at that point.

See [`server/README.md`](server/README.md) for setup, including the Cloudflare Tunnel guide, and [`ROADMAP.md`](ROADMAP.md) for what's next, including the CDN revisit.
