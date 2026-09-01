---
id: transcribe
title: Transcribe session
mode: script
run: python scripts/transcribe.py "{{inputs.session_dir}}"
outputs: [words.json, full.txt, media.json]
lock: gpu
timeout: 60m
---

Word-level transcription of the session's master audio (the phone clip).

- `out/words.json` — `{ "words": [{ "w", "start", "end" }], "segments": [...] }`
- `out/full.txt` — plain text
- `out/media.json` — every media file found in `session_dir` with absolute
  path, duration, and role: `master`, `screen`, or `extra`

The script should extract audio first (`ffmpeg -vn -ac 1 -ar 16000`), cache
the transcript next to the source (`<base>_words_<model>.json`) and reuse
it when present. Transcribing is the slow step; the cache is what makes
reruns cheap.
