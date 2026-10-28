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
   chapters replace the editor's; otherwise Auphonic's are used only if the episode had none.
   Show notes Auphonic wrote (`shownotes.summaries.long`) fill an empty description; if the episode already
   has one, the editor offers them with **Use as the description**.
5. An episode that isn't public yet can't be published while processing: Publish becomes
   "Publish when processing finishes" and it publishes automatically afterwards (a scheduled time
   that has passed means now). An episode that's already public stays up; its audio is swapped when ready.
6. **Reprocess** sends the kept original again with the current metadata (uses Auphonic credits).

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
| Show language | `speech_recognition.language` |
| "Let Auphonic create chapters" or "write show notes" | `speech_recognition.shownotes: true` (one Auphonic feature; paid plans; needs speech recognition) |

Output files: `mp3` at `128`; with transcripts also `subtitle` (`srt`, `webvtt`) and `transcript` (`txt`).

Not sent: season, episode type, explicit, people, value, funding, text records.
