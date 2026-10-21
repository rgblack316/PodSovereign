# FeedHost server

The app that imports a podcast feed, stores it in PostgreSQL, copies its media, and serves it again. It supports the full iTunes and Podcasting 2.0 tag sets, with per-user logins.

## Run it (Ubuntu Server)

The easy way is Docker: see **Install** in the [main README](../README.md) for the one-line installer and `update.sh`. The rest of this section is for running it directly with Node, for development or without Docker.

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

Then open the site (for example `http://127.0.0.1:8080/` on the server) and create the first account. As the admin, open **Site settings** to set the site's name, logo, favicon and web address. No code changes are needed to run your own copy.

To make it public, see [Cloudflare Tunnel](#cloudflare-tunnel) below.

## Site settings (admin panel)

Admins can change these from the dashboard. Saved values override the environment variables; a blank value falls back to them.

| Setting | Notes |
|---|---|
| Site name | Shown on the sign-in page, in the sidebar and in browser tabs (default "FeedHost") |
| Logo · Favicon | PNG, JPEG, WebP or SVG (favicon: PNG, SVG or ICO), up to 1 MB. Stored in `SITE_DIR`. Uploaded SVGs are served sandboxed |
| Web address | The public address, e.g. `https://podcasts.johnscreekstudios.com`. Must be a bare address (no path) |
| Media address | Optional. Episode files are served from here instead (a CDN in front of this server). With a storage provider, its public address is used |
| Sign-ups | Whether anyone can create an account |

## Ownership verification

So nobody can import a show they don't own, each import pauses after reading the feed. It shows a preview and waits until the person importing proves the show is theirs. **Nothing is saved or copied until then.** Either way works:

- **A tag in the feed.** Add `<podcast:txt purpose="verify">feedhost-verify-…</podcast:txt>` (the Podcasting 2.0 verification tag) to the feed at the current host, then click **Check my feed now**. Hosts without custom tags: paste the code into the show description instead. The tag can be removed after the import.
- **An emailed code.** A 6-digit code goes to the owner address in the feed (`<itunes:owner>`, or `<managingEditor>`), never to the person importing. Codes last 30 minutes, are stored only as a hash, allow 5 tries, and can be resent once a minute, up to 5 times.

Admins can **skip** verification for shows they manage. Unfinished verifications expire after 7 days, and cancelling is always possible. **Site settings → Ownership verification** turns the requirement on or off (on by default) and sets how email is sent, through **Resend** or an **SMTP server**:

| Option | Settings |
|---|---|
| Resend | API key with Sending access (resend.com/api-keys); the From address must be on a domain verified at resend.com/domains |
| SMTP server | Mail server, security (STARTTLS 587, TLS 465, or none; certificates are checked), port, optional username and password (AUTH PLAIN or LOGIN) |
| Both | From, e.g. `Johns Creek Studios <podcasts@johnscreekstudios.com>` |

Keys and passwords are never shown again after saving. Resend requests carry an idempotency key, so a retry never sends twice, and common Resend errors (bad key, unverified domain, quota) are explained in plain words.

**Send test email** confirms the settings work. Without email set up, podcasters verify with the feed tag.

## Media storage

Under **Site settings → Media storage**, admins choose where episode files, artwork, transcripts and chapter files are kept.

| Provider | You'll need | Public address |
|---|---|---|
| This server | Nothing (the default) | The site address, or a pull-through CDN set as the media address |
| Cloudflare R2 | Account ID, an R2 API token's access key ID and secret (Object Read & Write), bucket | A custom domain connected to the bucket (r2.dev is for testing only) |
| Backblaze B2 | S3 endpoint (`s3.<region>.backblazeb2.com`), application key ID and key (not the master key), bucket | Public bucket's friendly URL `https://f00X.backblazeb2.com/file/<bucket>` |
| Amazon S3 | Region, access key ID and secret, bucket | CloudFront, or a public bucket |
| Wasabi | Region (all 16 listed), access key and secret, bucket | Public bucket or a CDN; optional per-file public-read |
| DigitalOcean Spaces | Region (all 13 listed), access key and secret, bucket | Spaces CDN; uploads are marked public-read automatically |
| Bunny Storage | Storage zone name, its **password**, main region | The linked pull zone, `https://<zone>.b-cdn.net` |
| Other S3-compatible | Endpoint, region, keys, bucket, path-style option | Whatever the provider gives |

**Tested so far:** Cloudflare R2 is in production use. The other providers (Backblaze B2, Amazon S3, Wasabi, DigitalOcean Spaces, Bunny Storage and other S3-compatible services) are built to each provider's documentation and pass the automated tests against a simulated server, but haven't been tried with real accounts yet. They're marked **Not yet tested** in Site settings. If you try one and hit a problem, please [open an issue](https://github.com/rgblack316/podcast-feed-import-and-host/issues) with what happened (the Test connection results help), or send a pull request with a fix.

- **Test connection** uploads a small file, reads it back, downloads it from the public address (as podcast apps will), and deletes it. Each step shows a pass or fail with an explanation.
- **Saving** runs the same test first and changes nothing if it fails. Secrets are never sent back to the browser; leave the field blank to keep the saved one.
- **Switching with media already stored** starts a background move. Every file is copied to the new storage while the current one keeps serving, and imports pause meanwhile. Once every file has moved, links are rewritten and the switch happens. If any file fails, nothing switches and you can save again to retry. Moving off this server deletes the local copies afterwards; moving between providers leaves the old bucket untouched.
- **Old links keep working:** after files leave this server, requests for their old `/<show>/media/...` addresses are redirected (301) to the new location.
- The S3 client signs requests with AWS Signature V4 and is checked against AWS's published examples; uploads over 64 MB go up in parts. Bunny uses its own storage API with SHA-256 checksums.

Files are laid out by their URL path everywhere: `<show>/media/<type>/<file>`, on disk (under `MEDIA_DIR`) and in buckets alike.

**Changing the web or media address after shows exist** rewrites every stored link to this server's media: episodes, artwork, transcripts, chapters (including chapter files on disk), people images and show notes. GUIDs are never changed. The old hostname is remembered: any request that still reaches this server on it is permanently redirected to the new address. So keep the old hostname pointed at this server, through DNS or your tunnel, and subscribers follow along.

## Dashboard

The dashboard is served at `/`. It's plain JavaScript and CSS in `web/`, with no build step.

- **Each show** opens with a status strip (feed live, media copied, old feed redirecting here, Podping, on air) and four tabs:
  - **Overview:** while a show is being set up. For an import, the move checklist: media copied, a check that the old host's 301 redirect is in place (and permanent), then Podping. For a new show, what Apple Podcasts and Spotify still need. It hides 7 days after every step is done, with a notice saying when, and comes back if a step stops being done.
  - **Show details:** artwork, title, description, categories, owner, people, locations, value for value, support links, recommended shows, schedule, license and every other channel tag.
  - **Episodes:** the episode list (10, 25, 50 or all per page) and the live shows (scheduled or on-air ones at the top). Publish new episodes and edit any episode, imported or new (see [Publishing](#publishing)).
  - **Settings:** Podping, stats prefixes (checkboxes, ID fields where needed, order arrows, link preview), the team, the feed address and show facts, and (owners) deleting the show.
- **Team:** the owner adds people by email as **editors** (episodes, show details, prefixes, Podping, live shows) or **viewers** (read only), changes roles, removes people, or hands ownership to a team member (staying on as an editor). Members can leave a show.
- **Import a show,** with live progress and the import notes, or **Start a new show** from scratch.
- **Account** (change password) and **People** (admins): add accounts, see each account's shows and roles, make or remove administrators (there's always at least one), and delete accounts. Deleting an account that owns shows asks whether to give those shows to someone else or delete them.

Security: the pages are served with a strict Content Security Policy (scripts only from this server), all feed content is shown as plain text, and every change goes through the same API checks as before.

The typeface (Archivo) loads from Google Fonts. Without internet access, the dashboard falls back to the system font.

Migrations run automatically on startup. The **first account registered becomes the admin**. After that, the admin creates accounts unless `ALLOW_REGISTRATION=1`.

### Publishing

- **New shows** get a feed straight away, a `podcast:guid` made from the feed address, and Podping switched on (there's no old host to move away from).
- **Episodes** are a draft (not in the feed), published now, or scheduled for a date. Saving a draft without audio is fine; publishing needs it.
- **Uploads** (audio, video, artwork, transcripts, chapters) are sent in 8 MB chunks, because Cloudflare Tunnel refuses any request over 100 MB. A dropped connection resumes where it stopped. Files are stored with the rest of the show's media (`<show>/media/audio/…`), on this server or the storage provider.
- **Length and image size are read from the file:** MP3 (including VBR), M4A/MP4, WAV and Opus for `itunes:duration`; PNG, JPEG and WebP for the artwork check. You can type the length over it.
- **People** (`podcast:person`) have their own form on both Show details and each episode: name, role (from the Podcast Taxonomy, which also sets the group), photo and link, in the order you set. Per the Podcast Namespace, an episode's people *replace* the show's for that episode, so an episode is either "Same as the show" or has its own list (with a button to copy in the show's people, and a warning if no host is listed).
- **Locations** (`podcast:location`) have their own form on Show details and each episode, several per show or episode: the place name, what it means (*what it's about* or *where it was made*), coordinates, OpenStreetMap ID and country. **Look up** searches OpenStreetMap and fills those in; you can also type them. The lookup uses the public Nominatim service (one search a second, only when you press Look up); set `NOMINATIM_URL` to use your own.
- **Value for value, support links, recommended shows, schedule, license and text records** (`podcast:value`, `funding`, `podroll`, `updateFrequency`, `license`, `txt`) have their own forms too:
  - **Value:** method, suggested amount (with the sats it works out to), and recipients (Lightning address or node, split in shares with the resulting percentage, fee, optional custom record). Time splits and other tags inside a value block are kept in an advanced box. Per the spec an episode's value replaces the show's, so an episode is "Same as the show" or has its own split (started from a copy of the show's).
  - **Recommended shows:** paste a show's feed address; its title and `podcast:guid` are filled in (feeds without one get the GUID the spec defines from the feed address).
  - **Schedule:** daily, weekly, every two weeks, monthly, every two months, or a custom iCalendar rule; optional start date and "no more episodes".
  - **License:** common Creative Commons licenses, or a custom name and link. Episodes default to the show's.
  - Show only: recommended shows and schedule. Show and episode: value, support links, license, text records.
  - **Upgrading:** these tags were already stored individually, so after an update the forms simply show what's there (from an import or the XML box). Nothing changes in the feed until a field is edited.
- **Transcripts and chapters** have their own fields. **Every other tag** (soundbites, value, alternate enclosures, anything an import brought along) is editable as XML under *More tags and options*, checked before it's saved. Editing one field never changes the others.
- **Podping:** a newly published or scheduled episode is announced when it appears in the feed; editing or unpublishing a public episode announces the change. The show's Podping switch still applies.
- **Files are cleaned up:** replacing the audio or artwork, or deleting an episode, removes files nothing else uses. Uploads never saved into an episode are removed after two days.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://feedhost@localhost/feedhost` | PostgreSQL connection |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Public address of the site and feeds (Site settings overrides it) |
| `MEDIA_BASE_URL` | same as `PUBLIC_BASE_URL` | Address used in media URLs. Set a CDN address here later (see [ROADMAP](../ROADMAP.md)) |
| `MEDIA_DIR` | `/var/lib/feedhost/media` | Where copied media is stored |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | Listen address. Local-only by default, so it's reachable only through the tunnel |
| `ALLOW_REGISTRATION` | off | Let anyone sign up |
| `COOKIE_SECURE` | on if the public URL is https | Secure session cookies |
| `MAX_MEDIA_BYTES` | 4 GB | Per-file download limit |
| `DOWNLOAD_CONCURRENCY` | 3 | Parallel media downloads per import |
| `ALLOW_PRIVATE_NETWORKS` | off | Allow imports from local or private addresses (dev only) |
| `SITE_NAME` | `FeedHost` | Starting site name (Site settings overrides it) |
| `SITE_DIR` | `/var/lib/feedhost/site` | Where the uploaded logo and favicon are stored |
| `PODPING_HUB_URL` | `https://hub.podcastindex.org/pubnotify` | The Podcast Index hub endpoint |
| `PODPING_DELAY_SEC` | `30` | Wait before sending, so a burst of edits becomes one ping |

### Public URLs

```
Feed:   https://podcasts.johnscreekstudios.com/<show>/feed.xml
Media:  https://podcasts.johnscreekstudios.com/<show>/media/<type>/<file>
```

`<show>` is the podcast's address (slug), chosen on import. Names that would collide with app routes, such as `api`, `feed` or `admin`, are reserved. **Don't change this layout once real shows are live:** subscribers' apps hold these URLs.

## Podping

When a feed changes, the server tells Podcast Index's open hub, which checks the feed right away and announces it through [Podping](https://podping.org), so apps refresh it within minutes instead of waiting for their next check. No key or setup is needed:

`GET https://hub.podcastindex.org/pubnotify?url=<feed>&podping=1`

- **Each show has its own switch, off after import.** Nothing is announced while the podcaster moves media and sets up the 301 redirect at the old host. Turning the switch on (`PUT /api/podcasts/:id/podping {"enabled": true}`) announces the feed once. Turning it off cancels any pings still waiting.
- **When it pings (switch on):** when an episode is published or a scheduled one's time arrives; when a public episode is edited, unpublished or deleted; when show details or stats prefixes change; when a live show starts or ends. Imports never ping.
- **What else it does:** a burst of changes is sent as one ping, and failures are retried with backoff (30s, 1m, 2m, 4m, 8m) before giving up. Feeds include `<podcast:podping usesPodping="true"/>` while the show's switch is on; the old host's tag is dropped on import.
- **Status:** `GET /api/podcasts/:id/podping` shows recent pings.

## Live shows (`podcast:liveItem`)

Each show can announce live broadcasts in its feed. Apps that support Podcasting 2.0 live items show them as upcoming, live now, or ended.

- **Create** a live item with a title, start time (and optionally an end time), the stream URL, and optional description, image and links ("Watch on YouTube", for example). It starts as **pending**.
- **Change status:** pending → **live** → **ended**.
  - Going live notifies the hub so apps see it right away. If you go live before the scheduled start, the start time moves to now.
  - Ending notifies the hub and records the real end time.
  - Removing a live item that's still live counts as ending it.
  - Pings follow the show's Podping switch.
- **Imported live items** can be edited the same way. Tags inside them that FeedHost doesn't manage, such as `podcast:chat` or `podcast:value`, are kept as they are. The live item's GUID never changes.
- **FeedHost doesn't stream.** The stream URL points at your own streaming service, such as Icecast or a YouTube or Twitch live page. A built-in streaming server is on the [roadmap](../ROADMAP.md) as a possible future upgrade.

Example:
```bash
POST /api/podcasts/<id>/live
{"title": "Election Night Live", "start": "2026-11-03T20:00:00-05:00",
 "streamUrl": "https://icecast.example/live.mp3",
 "contentLinks": [{"href": "https://youtube.com/live/xyz", "text": "Watch on YouTube"}]}

POST /api/podcasts/<id>/live/<liveId>/status   {"status": "live"}
POST /api/podcasts/<id>/live/<liveId>/status   {"status": "ended"}
```

## Cloudflare Tunnel

The app runs on your machine and Cloudflare forwards `https://podcasts.johnscreekstudios.com` to it, so there are no open ports and no certificates to manage.

**With Docker (simplest).** In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and copy its token. Give it to the installer, or add it to `/opt/feedhost/.env` later:

```
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
COMPOSE_PROFILES=tunnel
```

then run `sudo docker compose up -d`. In the tunnel's **Public Hostname** tab, point `podcasts.johnscreekstudios.com` at the service `http://app:8080`. Steps 1–3 below are then unnecessary; step 4 still applies.

**Without Docker, or with cloudflared installed on the machine:**

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

All `/api` calls use a session cookie. Requests that change something must send `Content-Type: application/json` (upload chunks: `application/octet-stream`).

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | anyone |
| GET | `/api/setup` (first-run status) | anyone |
| GET | `/api/me` · POST `/api/me/password` | signed in |
| GET · POST | `/api/admin/users` · PATCH `/api/admin/users/:userId` `{isAdmin}` · DELETE `{shows: "transfer", transferTo} \| {shows: "delete"}` | admin |
| GET | `/api/podcasts/:id/team` | viewer+ |
| POST · PATCH · DELETE | `/api/podcasts/:id/team` `{email, role}` · `/team/:userId` `{role}` (role `owner` hands the show over) | owner (members may remove themselves) |
| GET · PUT | `/api/admin/site` · POST/DELETE `/api/admin/site/logo` and `/favicon` | admin |
| GET | `/site/logo` · `/site/favicon` | public |
| GET · PUT | `/api/admin/storage` · POST `/api/admin/storage/test` | admin |
| GET | `/api/podcasts` | your own shows, plus ones shared with you |
| POST | `/api/podcasts` `{title, slug?, …show details}` (start a new show) | signed in |
| GET | `/api/categories` (Apple categories, podcast:medium values) · `/api/places?q=` (OpenStreetMap place lookup) · `/api/feed-lookup?url=` (another show's title and GUID) | signed in |
| GET | `/api/podcasts/:id` · `/episodes` · `/episodes/:episodeId` · `/details` · `/prefixes` | viewer+ |
| PUT | `/api/podcasts/:id/details` (show details) | editor+ |
| POST · PATCH · DELETE | `/api/podcasts/:id/episodes` · `/episodes/:episodeId` (PATCH changes only the fields sent) | editor+ |
| POST | `/api/podcasts/:id/uploads` `{filename, size, kind?}` → `{upload}` | editor+ |
| GET · PUT · DELETE | `/api/podcasts/:id/uploads/:uploadId` (status · chunk at `?offset=` · cancel) | editor+ |
| POST | `/api/podcasts/:id/uploads/:uploadId/complete` → `{media}` | editor+ |
| DELETE | `/api/podcasts/:id/media/:mediaId` (only when unused) | editor+ |
| POST | `/api/podcasts/:id/redirect-check` (is the old feed 301-redirecting here?) | editor+ |
| PUT | `/api/podcasts/:id/prefixes` | editor+ |
| GET · PUT | `/api/podcasts/:id/podping` (status · show switch) | viewer+ · editor+ |
| GET · POST | `/api/podcasts/:id/live` (list · create) | viewer+ · editor+ |
| PATCH · DELETE | `/api/podcasts/:id/live/:liveId` | editor+ |
| POST | `/api/podcasts/:id/live/:liveId/status` `{status}` | editor+ |
| DELETE | `/api/podcasts/:id` | owner |
| POST | `/api/imports` `{url, slug?}` · GET `/api/imports` · `/api/imports/:id` | your own imports |
| POST | `/api/imports/:id/check-feed` · `/send-code` · `/verify-code` `{code}` · `/cancel` | your own imports |
| POST | `/api/imports/:id/skip-verification` · `/api/admin/site/test-email` | admin |
| GET | `/:slug/feed.xml` · `/:slug/media/:type/:file` | public |

If you don't have access to a podcast, you get **404**, so the existence of other people's shows isn't revealed.

## Tests

```bash
npm test     # about 200 tests: feed engine, import, publishing, uploads, API, access, storage, Podping
```

`npm run demo` starts a throwaway demo (two imported shows, one on air) at `http://127.0.0.1:8099`, signed in as `randy@johnscreekstudios.com` with the password `demo password 123`. It uses the same local test database as the tests below.

The import and API tests need a local PostgreSQL that allows trust auth for the `postgres` user over its Unix socket. Set `TEST_PG_SOCKET` if the socket isn't at `/var/run/postgresql/.s.PGSQL.5432`. Each test file creates its own throwaway database.

## How it works

| Area | Files |
|---|---|
| Feed engine | `src/feed/`: parser, builder, stats prefixes, media references |
| Database | `src/db/`: migrations, feed save/load, the `podcastRole` access check |
| Import | `src/import/`: SSRF-guarded HTTP, job queue, ownership verification, resumable media copy |
| Email | `src/mail/`: Resend API client and SMTP client (TLS, STARTTLS, AUTH PLAIN/LOGIN) |
| Accounts | `src/auth/`: scrypt passwords, hashed session tokens, login rate limiting |
| HTTP | `src/http/`: routes, CSRF checks, public feed with ETag caching, 301 check, dashboard files |
| Dashboard | `web/`: index.html, app.js, styles.css |
| Media storage | `src/storage/`: local disk, S3-compatible (SigV4) and Bunny clients, connection test, background moves |
| Site settings | `src/site/`: branding, web and media address (with link rewrite and old-host redirects), sign-ups |
| Podping | `src/podping/`: change queue, Podcast Index hub notifier, scheduled-episode announcer |
| Live | `src/live/`: `podcast:liveItem` create, edit, status changes (each announced through Podping) |
| Publishing | `src/publish/`: new shows, show details, episodes, Podcasting 2.0 tag forms (`tag-fields.ts`), people, locations, categories |
| Uploads | `src/media/`: chunked resumable uploads, length and image-size detection, cleanup of unused files |
| Teams | `src/db/team.ts`: show members and roles, ownership hand-over, deleting accounts |
| Tools | `src/cli/`: `reset-password.ts` (forgotten passwords), `preview.ts` (try the parser on any feed) |

### Import, step by step
1. Fetch the feed. Redirects are followed, and private and internal addresses are blocked, even through DNS tricks.
2. Refuse the import if the feed is `<podcast:locked>`, if you have already imported it, or if another account already hosts it.
3. Wait for ownership verification (see above), unless it's turned off or an admin skips it.
4. Save everything. Existing stats prefixes are detected and pre-checked, and a `podcast:guid` is generated if the feed has none.
5. Copy every file: audio, video, alternate versions, artwork, transcripts, chapters, people images and trailers, plus **images embedded in show notes** and **images listed inside chapter files**. Chapter files are rewritten to point at the copies. Live streams, plain links and IPFS/torrent sources are skipped.
6. Rewrite the URLs to point at this server. Files that fail to copy keep their original URL and are listed as warnings.

### Storage layout

```
MEDIA_DIR/                    (or the bucket root)
└── <podcast-slug>/
    └── media/
        ├── audio/   video/   images/   transcripts/   chapters/   other/
```

Files are named `<10-char hash>-<original name>`, for example `3f9a1c22b0-episode-12.mp3`. Deleting a podcast removes its folder. Public URLs follow the same layout: `MEDIA_BASE_URL/<slug>/media/<type>/<file>`.

If the server restarts mid-import, the job resumes and only downloads the files that hadn't finished.
