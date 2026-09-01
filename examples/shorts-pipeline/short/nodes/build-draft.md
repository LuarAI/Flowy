---
id: build-draft
title: Build editor draft
mode: script
needs: [edit-plan, transcribe, record-vo]
run: python "{{workflow.scripts}}/build_draft.py" "{{item.slug}}" "{{inputs.brand_dir}}"
outputs: [draft.json, edit.otio]
lock: editor
before:
  - python "{{workflow.scripts}}/check_editor_closed.py"
timeout: 10m
---

Renders the portable edit plan into an editable project for the human's
editor, and writes the same cut list as OpenTimelineIO.

- Reads `in/edit-plan/structured.json`, `in/edit-plan/captions.srt`, the
  media paths from `in/transcribe/media.json`, `in/record-vo/vo.m4a`, and
  the music folder under `brand_dir`.
- Writes `out/edit.otio` (the portable cut list, editor-agnostic) and
  `out/draft.json` — `{ "name": "<draft name>", "path": "<where the editor
  will find it>", "editor": "<name and version>" }`.

The pre-check refuses to run while the editor is open, because the editor
overwrites external changes to its project folder on autosave. The `editor`
lock keeps two items from writing at the same time. Always create a new
draft name; never overwrite one the human may have edited.
