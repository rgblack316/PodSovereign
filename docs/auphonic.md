# Auphonic processing (spec)

Process episode audio with [Auphonic](https://auphonic.com/help/api/) before it's published:
noise reduction and loudness come from the podcaster's own **Auphonic preset**, PodSovereign
sends the episode's metadata and chapters, and brings back the processed MP3 and transcripts.

## Settings
- **Site settings → Auphonic:** API key (encrypted at rest), checked against `GET /api/user.json`.
- **Show → Settings → Auphonic:** on/off per show, the preset to use (from `GET /api/presets.json`),
  whether to create transcripts, where chapters come from (the chapter editor, or Auphonic), and whether
  Auphonic writes show notes. Output is always MP3, 128 kbps, stereo. The chapters and show-notes
  choices are defaults; each upload can change them.

## Flow
1. The podcaster uploads audio. PodSovereign keeps the original upload.
2. On save, an Auphonic production is created (`POST /api/productions.json`, `action: start`) with
   the preset, the metadata below, `input_file` = the original's public address (Auphonic fetches it),
   `image`, `chapters`, `output_files`, `speech_recognition` and a `webhook`.
3. Auphonic calls `POST /hooks/auphonic/<token>` when done; a worker also checks running productions
   every minute (`GET /api/production/{uuid}.json`; status 3 = done, 2 = error).
4. PodSovereign downloads the outputs (`download_url?bearer_token=…`), stores them, and updates the episode:
   the processed MP3 becomes the enclosure; SRT, VTT, TXT and Podcasting 2.0 JSON (built from the SRT)
   become its `podcast:transcript`s. Chapters: when "Let Auphonic create them" was chosen, Auphonic's
   chapters replace the editor's; otherwise Auphonic's are used only if the episode had none. Auphonic's chapters
   are sorted and the first one always starts at 00:00:00; when that changes a time, the chapters inside the
   processed MP3 are rewritten to match. They can be edited in the chapter editor like any others.
   Show notes Auphonic wrote (`shownotes.summaries.long`) fill an empty description; if the episode already
   has one, the editor offers them with **Use as the description**.
5. An episode that isn't public yet can't be published while processing: Publish becomes
   "Publish when processing finishes" and it publishes automatically afterwards (a scheduled time
   that has passed means now). An episode that's already public stays up; its audio is swapped when ready.
6. **Reprocess** sends the kept original again with the current metadata (uses Auphonic credits).

## File names
Files made from an episode's audio keep the upload's exact name: `ru053.mp3` is sent with
`output_basename: "ru053"` and stored as `ru053.mp3`, with `ru053.srt`, `ru053.vtt`, `ru053.txt` and `ru053.json`.
A later version (Reprocess, or chapters written into the MP3) replaces the file at the same address, and the
old copy is cleared from Cloudflare's cache (Site settings → Cloudflare cache: zone ID plus an API token with
Zone → Cache Purge). Listeners who already downloaded the old file keep their copy.
- If another episode (or the show) already uses a file by that name, processing is refused before anything is
  sent to Auphonic: each episode needs its own file name.
- An imported episode whose own audio already has that exact name: the original is moved to a prefixed
  address first (kept for reprocessing), then the processed file takes the name.
- The raw upload sent to Auphonic keeps its 8-character prefix; it's only the input kept for reprocessing.
- The same rule applies without Auphonic: an upload saved as an episode's audio is copied to its exact name
  (provider-side on R2 and other S3-compatible storage) and the prefixed upload is removed.

## Metadata sent
Only these fields are sent. Everything else (genre, summary, URL, license, …) comes from the preset.

| PodSovereign | Auphonic |
|---|---|
| Episode title | `metadata.title` |
| Episode number | `metadata.track` |
| Author name | `metadata.artist` |
| Podcast name | `metadata.album` |
| Owner name | `metadata.publisher` |
| The current year | `metadata.year` |
| (nothing) | `metadata.summary` is not sent |
| Episode art (the show's art when the episode has none, as in the feed) | `image` |
| Chapter editor: typed, imported from .txt/.json, or read from the MP3 | `chapters` (`start` HH:MM:SS.mmm, `title`, `url`, `image`); not sent when Auphonic makes the chapters |
| Show language, base code only (`en-us` → `en`; `auto` if Auphonic doesn't list it) | `speech_recognition.language` |
| "Let Auphonic create chapters" or "write show notes" | `speech_recognition.shownotes: true` (one Auphonic feature; paid plans; needs speech recognition) |

Output files: the preset's own output files (read with `GET /api/preset/{uuid}.json`) are sent as they are, with any MP3 entry replaced by `mp3` at `128` kbps, stereo (sending `output_files` replaces the preset's list, so it's copied). Transcript files are never added by PodSovereign itself: Auphonic's API refuses documented endings (`webvtt`, `txt`) when they're requested, and speech recognition adds the transcripts anyway. PodSovereign uses the SRT (or VTT) that comes back and makes the missing SRT, VTT, TXT and Podcasting 2.0 JSON files from it (only when the show's "Make transcripts" is on). The server log lists which files each production returned.

Not sent: season, episode type, explicit, people, value, funding, text records.
