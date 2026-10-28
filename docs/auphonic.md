# Auphonic processing (spec)

Process episode audio with [Auphonic](https://auphonic.com/help/api/) before it's published:
noise reduction and loudness come from the podcaster's own **Auphonic preset**, PodSovereign
sends the episode's metadata and chapters, and brings back the processed MP3 and transcripts.

## Settings
- **Site settings → Auphonic:** API key (encrypted at rest), checked against `GET /api/user.json`.
- **Show → Settings → Auphonic:** on/off per show, the preset to use (from `GET /api/presets.json`),
  and whether to create transcripts. Output is always MP3, 128 kbps, stereo.

## Flow
1. The podcaster uploads audio. PodSovereign keeps the original upload.
2. On save, an Auphonic production is created (`POST /api/productions.json`, `action: start`) with
   the preset, the metadata below, `input_file` = the original's public address (Auphonic fetches it),
   `image`, `chapters`, `output_files`, `speech_recognition` and a `webhook`.
3. Auphonic calls `POST /hooks/auphonic/<token>` when done; a worker also checks running productions
   every minute (`GET /api/production/{uuid}.json`; status 3 = done, 2 = error).
4. PodSovereign downloads the outputs (`download_url?bearer_token=…`), stores them, and updates the episode:
   the processed MP3 becomes the enclosure; SRT, VTT, TXT and Podcasting 2.0 JSON (built from the SRT)
   become its `podcast:transcript`s. Chapters Auphonic found in the file are used if the episode had none.
5. An episode that isn't public yet can't be published while processing: Publish becomes
   "Publish when processing finishes" and it publishes automatically afterwards (a scheduled time
   that has passed means now). An episode that's already public stays up; its audio is swapped when ready.
6. **Reprocess** sends the kept original again with the current metadata (uses Auphonic credits).

## Metadata sent (empty values are left out, so the preset's own values apply)
| PodSovereign | Auphonic `metadata` |
|---|---|
| Episode title | `title` |
| Episode number | `track` |
| Show author | `artist` |
| Show title | `album` |
| Publish year | `year` |
| — | `genre` = "Podcast" |
| Description (plain text) | `summary` |
| Owner name | `publisher` |
| Episode web page, else show website | `url` |
| License (episode, else show) | `license`, `license_url` |
| First location with coordinates | `location` |
| Episode art, else show art | `image` (top-level) |
| Chapter editor | `chapters` (`start` HH:MM:SS.mmm, `title`, `url`, `image`) |
| Show language | `speech_recognition.language` |

Output files: `mp3` at `128`; with transcripts also `subtitle` (`srt`, `webvtt`) and `transcript` (`txt`).

Not sent (no Auphonic field): season, episode type, explicit, people, value, funding, text records.
