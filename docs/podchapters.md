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

Saving the chapters also adds them to the episode's feed entry as **Podlove Simple Chapters** (`<psc:chapters>`),
next to the Podcasting 2.0 chapters file, for apps that read that format. They are made from the chapters you saved
(so your edits are included), not fetched from PodChapters. Hidden markers (such as ad breaks) are left out, because
Podlove has no way to hide one. This applies to every saved chapter list, whatever made it. Episodes whose chapters
were saved before this change get the block from a one-time catch-up: **Site settings → Podlove chapters for
existing episodes** shows how many episodes need it and adds it to all of them in the background. It reads each
episode's saved chapters file, adds only the Podlove block (nothing else about the episode changes, including its
date), skips episodes whose chapters file isn't stored on this site, and does nothing for episodes that already have
the block, so running it again is safe.

It is never run automatically, not on upload, not on publish, and not after Auphonic.

## What is sent

| Step | PodChapters call | Cost |
|---|---|---|
| Add the episode (first time only; later requests reuse it) | `POST /api/v1/episodes` with the audio's public address, title, podcast name, author and episode number; tags and presets are not imported | free |
| Send the transcript (every request, so it matches the audio now stored here) | `PUT /api/v1/episodes/{id}/transcript` with the episode's SRT, else VTT, else plain text | free |
| Make the chapters | `POST /api/v1/episodes/{id}/chapters/generate` (`mode: suggest`, the show's style, count, ads and links options) | 0.04 credits per minute |

An episode with no transcript is refused with a message (nothing is sent). Turn on transcripts in the show's Auphonic
settings and process the episode, or add a transcript to the episode.

A second request reuses the PodChapters copy while the episode's audio is unchanged. PodChapters can't replace an
episode's audio, so when the file changes (a reprocess) a new copy is made there, under a dated internal file name
(for example `ru053-20261118100500.mp3`; it never appears in your feed or files). The same happens if the copy was
deleted there, or its name is already taken.

## Errors

PodChapters' own message and hint are shown as they are (for example "Not enough credits. This needs 0.2 credits.").
The episode's existing chapters are never touched by a failed request.

`PODCHAPTERS_URL` (default `https://podchapters.com`) exists only for testing.

## Gemini as a second chapter maker

Gemini can make chapters from the same transcript, next to PodChapters.

- **Set up:** an administrator adds a Gemini API key and a model name in Site settings → Gemini (the key is checked before saving and stored encrypted). The model is a Flash-class one by default; change it there when Google renames models.
- **Per show:** Show settings → AI chapters has a checkbox for each chapter maker (at least one stays on) and the starting options for each run.
- **Per episode:** in the Chapters section, “Make chapters with AI” asks for the four options (number of chapters, title style, mark ads, add links) and which makers to run. Each maker runs in its own request, so each draft appears when it is ready and one failing doesn’t stop the other. Each draft is an editable list; “Use these chapters” puts it into the chapter editor, and nothing is saved until the episode is saved. Links and images already typed in stay when a new chapter starts at the same time.
- **Checks on Gemini’s answer:** every start time is moved to a real transcript line, chapters are sorted, de-duplicated, kept at least 30 seconds apart and capped (by the number setting and the episode length, never over 30); titles are cleaned; a link is kept only if it appears in the transcript; “Ad:” labels are dropped when ad marking is off. An unusable answer is asked for once more, with the problem.
- **Needs timings:** an SRT or VTT transcript. Plain text has no timings, so Gemini can’t be used with it.
- **Privacy and cost:** the transcript is sent to Google. Check the data-use terms for your API plan. One text call per episode costs cents.
