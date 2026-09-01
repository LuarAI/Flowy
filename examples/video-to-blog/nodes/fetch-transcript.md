---
id: fetch-transcript
title: Fetch transcript
mode: script
run: python scripts/fetch_transcript.py "{{inputs.video}}"
outputs: [transcript.md, video.json]
timeout: 20m
---

Fetches (or generates) a timestamped transcript for the input video.

- `out/transcript.md` — the transcript with `[mm:ss]` timestamps at least
  every paragraph, in the language spoken.
- `out/video.json` — `{ "id", "title", "url", "duration_s", "published" }`
  as far as the source provides them.

The script is the user's own; see `../scripts/README.md`. It may use a
platform transcript API, a local Whisper run, or a cached file — Flowy does
not care, as long as the two outputs appear.
