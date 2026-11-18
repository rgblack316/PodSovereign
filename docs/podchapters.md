# PodChapters

AI chapters, made **only when you ask**, from the episode's own transcript. PodChapters never transcribes here:
the transcript Auphonic made (which costs nothing extra) is sent to it, so the only charge is PodChapters' chapters
(0.04 credits per minute of audio).

## Setup

1. In PodChapters, create an API key under **Settings → API & MCP**. The plan needs AI chapters.
2. An admin pastes it under **Site settings → PodChapters**. The key is checked (plan and credits are shown) and stored encrypted.
3. Each show can set its style under **Settings → PodChapters**: how closely titles follow the spoken words
   (close / balanced / creative), how many chapters (fewer / moderate / more), whether ads and sponsor segments are
   marked (their titles start with "Ad:"), and whether links mentioned in the episode are added to their chapters.

## Using it

Open an episode's **Chapters** section and choose **Make chapters with PodChapters**. It confirms the cost first
(from the episode's length). The chapters appear in the editor to check and edit; **nothing is saved until you save
the episode**, and saving can also write them into the MP3 as usual. The first chapter always starts at 00:00:00.

It is never run automatically, not on upload, not on publish, and not after Auphonic.

## What is sent

| Step | PodChapters call | Cost |
|---|---|---|
| Add the episode (first time only; later requests reuse it) | `POST /api/v1/episodes` with the audio's public address, title, podcast name, author and episode number; tags and presets are not imported | free |
| Send the transcript (every request, so it matches the audio now stored here) | `PUT /api/v1/episodes/{id}/transcript` with the episode's SRT, else VTT, else plain text | free |
| Make the chapters | `POST /api/v1/episodes/{id}/chapters/generate` (`mode: suggest`, the show's style, count, ads and links options) | 0.04 credits per minute |

An episode with no transcript is refused with a message (nothing is sent). Turn on transcripts in the show's Auphonic
settings and process the episode, or add a transcript to the episode.

If the PodChapters copy of an episode was deleted there, a new one is made. If a file with the same name already
exists in the account (from an earlier run), that one is used.

## Errors

PodChapters' own message and hint are shown as they are (for example "Not enough credits. This needs 0.2 credits.").
The episode's existing chapters are never touched by a failed request.

`PODCHAPTERS_URL` (default `https://podchapters.com`) exists only for testing.
