---
id: titles
title: Titles and description
mode: agent
needs: [transcribe-vo, body]
context:
  - "{{inputs.brand_dir}}/titles-guide.md"
tools: [Read, Write]
outputs: [titles.md]
approve:
  chosen: { type: integer, required: true, description: "1-based index of the chosen option" }
  notes:  { type: string }
timeout: 10m
---

Write title, description and hashtag options for the short `{{item.slug}}`.

Read `in/transcribe-vo/full.txt` (what is actually said in the final
voice-over — the source of truth), `in/body/script.md` (the angle), and
follow `in/context/titles-guide.md` exactly.

Write `out/titles.md` with five numbered options in {{inputs.language}}.
Each option: a title line (keyword first, then the hook; within the length
the guide sets), a description (≤ 3 lines, reads natively on every
platform), and one hashtag line. The same text is pasted everywhere, so no
platform-specific phrasing.
