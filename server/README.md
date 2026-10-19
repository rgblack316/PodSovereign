# FeedHost server

The app that imports a podcast feed, stores it in PostgreSQL, copies its media, and serves it again. It supports the full iTunes and Podcasting 2.0 tag sets, with per-user logins.

## Run it (Ubuntu Server)

```bash
# Node 22+ and PostgreSQL
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs postgresql
sudo -u postgres createuser feedhost -P        # choose a password
sudo -u postgres createdb -O feedhost feedhost
sudo mkdir -p /var/lib/feedhost/media && sudo chown "$USER" /var/lib/feedhost/media

npm install
DATABASE_URL=postgres://feedhost:PASSWORD@localhost/feedhost \
PUBLIC_BASE_URL=https://podcasts.johnscreekstudios.com \
npm start
```

To make it public, see [Cloudflare Tunnel](#cloudflare-tunnel) below.

Migrations run automatically on startup. The **first account registered becomes the admin**. After that, the admin creates accounts unless `ALLOW_REGISTRATION=1`.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://feedhost@localhost/feedhost` | PostgreSQL connection |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Public address of the site and feeds |
| `MEDIA_BASE_URL` | same as `PUBLIC_BASE_URL` | Address used in media URLs. Set a CDN address here later (see [ROADMAP](../ROADMAP.md)) |
| `MEDIA_DIR` | `/var/lib/feedhost/media` | Where copied media is stored |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address. Local-only by default, so it's reachable only through the tunnel |
| `ALLOW_REGISTRATION` | off | Let anyone sign up |
| `COOKIE_SECURE` | on if the public URL is https | Secure session cookies |
| `MAX_MEDIA_BYTES` | 4 GB | Per-file download limit |
| `DOWNLOAD_CONCURRENCY` | 3 | Parallel media downloads per import |
| `ALLOW_PRIVATE_NETWORKS` | off | Allow imports from local or private addresses (dev only) |

### Public URLs

```
Feed:   https://podcasts.johnscreekstudios.com/<show>/feed.xml
Media:  https://podcasts.johnscreekstudios.com/<show>/media/<type>/<file>
```

`<show>` is the podcast's address (slug), chosen on import. Names that would collide with app routes, such as `api`, `feed` or `admin`, are reserved. **Don't change this layout once real shows are live:** subscribers' apps hold these URLs.

## Cloudflare Tunnel

The app runs on your machine and Cloudflare forwards `https://podcasts.johnscreekstudios.com` to it, so there are no open ports and no certificates to manage.

**1. Install cloudflared and create the tunnel**

```bash
# Cloudflare's apt repository (see Cloudflare's docs for the current instructions)
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

cloudflared tunnel login                         # pick johnscreekstudios.com
cloudflared tunnel create feedhost               # prints the tunnel ID
cloudflared tunnel route dns feedhost podcasts.johnscreekstudios.com
```

**2. Point the tunnel at the app.** Create `/etc/cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /etc/cloudflared/<TUNNEL-ID>.json   # copy it from ~/.cloudflared/
ingress:
  - hostname: podcasts.johnscreekstudios.com
    service: http://127.0.0.1:8080
  - service: http_status:404
```

```bash
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

**3. Run the app with** `PUBLIC_BASE_URL=https://podcasts.johnscreekstudios.com`. Session cookies are marked Secure automatically.

**4. Cloudflare dashboard settings.** These matter because podcast apps and directories (Apple, Spotify, Overcast, Podcast Index) fetch feeds automatically, without a browser, and challenge pages break them.
- Turn **Bot Fight Mode off**. On the free plan it can't be limited to certain paths.
- Never enable **"I'm Under Attack" mode** for this hostname.
- Add a WAF custom rule with the **Skip** action for paths ending in `/feed.xml` or containing `/media/`. Have it skip Browser Integrity Check and Security Level challenges.
- Feeds (`.xml`) aren't cached by Cloudflare by default, so new episodes show up immediately. Media files are cacheable, and the app sends a one-day `Cache-Control` for them.

**What the app already handles behind the tunnel**
- **Visitor addresses.** Every request arrives from `cloudflared` on this machine, so the app reads `CF-Connecting-IP`, but only from a local hop. Login lockouts then apply to the real visitor, not to everyone at once.
- **Byte ranges and HEAD requests** for media, which podcast apps need for seeking and resuming, pass through the tunnel unchanged.

**Limits to keep in mind**
- Cloudflare's terms restrict serving video, or a disproportionate amount of large files, on Free, Pro and Business plans, and this applies to Tunnel hostnames.
- Uncached downloads use your home upload bandwidth.
- Moving media to a CDN after testing is on the [roadmap](../ROADMAP.md).

## API

All `/api` calls use a session cookie. Requests that change something must send `Content-Type: application/json`.

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | anyone |
| GET | `/api/me` · POST `/api/me/password` | signed in |
| POST | `/api/admin/users` | admin |
| GET | `/api/podcasts` | your own shows, plus ones shared with you |
| GET | `/api/podcasts/:id` · `/episodes` · `/prefixes` | viewer+ |
| PUT | `/api/podcasts/:id/prefixes` | editor+ |
| DELETE | `/api/podcasts/:id` | owner |
| POST | `/api/imports` `{url, slug?}` · GET `/api/imports` · `/api/imports/:id` | your own imports |
| GET | `/:slug/feed.xml` · `/:slug/media/:type/:file` | public |

If you don't have access to a podcast, you get **404**, so the existence of other people's shows isn't revealed.

## Tests

```bash
npm test     # 52 tests: feed engine, import worker, API and isolation
```

The import and API tests need a local PostgreSQL that allows trust auth for the `postgres` user over its Unix socket. Set `TEST_PG_SOCKET` if the socket isn't at `/var/run/postgresql/.s.PGSQL.5432`. Each test file creates its own throwaway database.

## How it works

| Area | Files |
|---|---|
| Feed engine | `src/feed/`: parser, builder, stats prefixes, media references |
| Database | `src/db/`: migrations, feed save/load, the `podcastRole` access check |
| Import | `src/import/`: SSRF-guarded HTTP, job queue, resumable media copy |
| Accounts | `src/auth/`: scrypt passwords, hashed session tokens, login rate limiting |
| HTTP | `src/http/`: routes, CSRF checks, public feed with ETag caching |

### Import, step by step
1. Fetch the feed. Redirects are followed, and private and internal addresses are blocked, even through DNS tricks.
2. Refuse the import if the feed is `<podcast:locked>`, if you have already imported it, or if another account already hosts it.
3. Save everything. Existing stats prefixes are detected and pre-checked, and a `podcast:guid` is generated if the feed has none.
4. Copy every file: audio, video, alternate versions, artwork, transcripts, chapters, people images and trailers, plus **images embedded in show notes** and **images listed inside chapter files**. Chapter files are rewritten to point at the copies. Live streams, plain links and IPFS/torrent sources are skipped.
5. Rewrite the URLs to point at this server. Files that fail to copy keep their original URL and are listed as warnings.

### Storage layout

```
MEDIA_DIR/
└── <podcast-slug>/          one folder per podcast
    ├── audio/   video/   images/   transcripts/   chapters/   other/
```

Files are named `<10-char hash>-<original name>`, for example `3f9a1c22b0-episode-12.mp3`. Deleting a podcast removes its folder. Public URLs follow the same layout: `MEDIA_BASE_URL/<slug>/media/<type>/<file>`.

If the server restarts mid-import, the job resumes and only downloads the files that hadn't finished.
