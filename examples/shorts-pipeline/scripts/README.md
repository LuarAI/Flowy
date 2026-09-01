# Scripts contract

Flowy ships none of these. They are yours. Each runs in the node's version
directory with `FLOWY_IN`, `FLOWY_OUT`, `FLOWY_NODE`, `FLOWY_RUN`, and one
`FLOWY_INPUT_<NAME>` per declared input. Exit non-zero on failure.

## `transcribe.py <path>`

Used twice: for the session (a folder) and for the voice-over (a file).

- Folder: pick the master clip (phone video), extract mono 16 kHz audio,
  run word-level speech-to-text, and inventory every media file.
- File: transcribe it.
- Writes `FLOWY_OUT/words.json` (`words[]` with `w`, `start`, `end`;
  `segments[]`), `FLOWY_OUT/full.txt`, `FLOWY_OUT/media.json`
  (`[{path, duration_s, role: master|screen|extra}]`).
- Cache the transcript next to the source as `<base>_words_<model>.json`
  and reuse it. Do not run while a render is using the GPU — the node
  holds the `gpu` lock for that reason.

## `sync_screen.py`

- Reads `FLOWY_IN/transcribe/media.json`. If a `screen` entry exists,
  extracts both audio tracks and cross-correlates to find the offset;
  writes `FLOWY_OUT/offsets.json` (`screen: {path, offset_s, confidence}`
  or `screen: null`).
- Remux screen recordings the editor cannot import (`.mkv` → `.mp4`,
  stream copy) and report the new path.

## `build_draft.py <slug> <brand_dir>`

- Reads `FLOWY_IN/edit-plan/structured.json`, `FLOWY_IN/edit-plan/captions.srt`,
  `FLOWY_IN/transcribe/media.json`, `FLOWY_IN/record-vo/vo.m4a`, and
  `<brand_dir>/music/`.
- Writes `FLOWY_OUT/edit.otio` (OpenTimelineIO; two video tracks, one
  audio track, one caption track) and the editor's project under a **new**
  draft name, then `FLOWY_OUT/draft.json` (`name`, `path`, `editor`).
- All positions absolute and frame-snapped. Mute both video layers; the VO
  is the audio. Keep caption text as editable text, not burned in.
- Pin the editor version you generate for. Draft formats change between
  releases and some versions encrypt project files.

## `check_editor_closed.py`

- Exits 0 if no editor process is running, else exits 1 with a one-line
  reason on stderr. Used as a `before:` check so the `build-draft` node is
  `blocked` with a readable message instead of silently corrupting a
  project.
