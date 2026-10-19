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
PUBLIC_BASE_URL=https://feeds.example.com \
npm start
```

Migrations run automatically on startup. The **first account registered becomes the admin**. After that, the admin creates accounts unless `ALLOW_REGISTRATION=1`.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://feedhost@localhost/feedhost` | PostgreSQL connection |
| `PUBLIC_BASE_URL` | `http://localhost:8080` | Public address used for feed and media URLs |
| `MEDIA_DIR` | `/var/lib/feedhost/media` | Where copied media is stored |
| `PORT` | `8080` | HTTP port |
| `ALLOW_REGISTRATION` | off | Let anyone sign up |
| `COOKIE_SECURE` | on if the public URL is https | Secure session cookies |
| `MAX_MEDIA_BYTES` | 4 GB | Per-file download limit |
| `DOWNLOAD_CONCURRENCY` | 3 | Parallel media downloads per import |
| `ALLOW_PRIVATE_NETWORKS` | off | Allow imports from local or private addresses (dev only) |

In production, Nginx should serve `/media/` straight from `MEDIA_DIR`. The app's own `/media/` route is meant for development.

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
| GET | `/feeds/:slug.xml` | public |

If you don't have access to a podcast, you get **404**, so the existence of other people's shows isn't revealed.

## Tests

```bash
npm test     # 47 tests: feed engine, import worker, API and isolation
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
4. Copy every file: audio, video, artwork, transcripts, chapters, people images, trailers. Live streams are skipped.
5. Rewrite the URLs to point at this server. Files that fail to copy keep their original URL and are listed as warnings.

If the server restarts mid-import, the job resumes and only downloads the files that hadn't finished.
