---
id: edit-plan
title: Edit plan
mode: agent
needs: [transcribe-vo, body, transcribe, sync-screen, plan]
context:
  - ../context/shorts-craft.md
  - ../context/transcription-fixes.md
tools: [Read, Write]
outputs: [structured.json, captions.srt]
schema: ../schemas/edit.schema.json
timeout: 15m
---

Turn the recorded voice-over and the approved beat sheet into a **portable
edit plan**: which source ranges play under which VO words, and the
captions. No editor-specific output here — the next node renders it.

Read:

- `in/transcribe-vo/words.json` — the VO, word-level. These times are the
  timeline. Total VO length is the short's length.
- `in/body/script.md` — the approved beats with their source ranges.
- `in/transcribe/words.json` and `in/_inputs.json` → `item.source_ranges`
  for the b-roll in the master clip.
- `in/sync-screen/offsets.json` — if a screen recording exists, its offset;
  screen time = master time − offset.
- `in/context/transcription-fixes.md` — known mishearings to correct in
  captions. Also compare captions against the approved script; the script
  wins over the transcription for spelling and proper nouns.

Produce the structured output:

- `fps`, `duration_s`
- `beats[]` — `{ "id", "vo_start", "vo_end", "master": {"start","end"},
  "screen": {"start","end"} | null }` — one per beat, contiguous on the VO
  timeline, frame-snapped. If the screen layer exists, every timeline
  instant must show the same real-world moment on both layers.
- `audio` — `{ "vo": "in/record-vo/vo.m4a", "parts": [...] }` (split
  points if it is a loop short)
- `music` — a mood from the ones listed in `shorts-craft.md`, and the
  target level relative to the VO
- `loop` — `null`, or `{ "seam_word_index": n }` with the visual rule:
  the closing clip's source range ends exactly where the opening clip's
  begins.

And write `out/captions.srt` from the corrected VO words, sentence case,
one short phrase per cue, in {{inputs.language}}.
