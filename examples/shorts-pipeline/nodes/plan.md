---
id: plan
title: Plan shorts
mode: agent
needs: [transcribe]
context:
  - context/shorts-craft.md
  - "{{inputs.brand_dir}}/voice.md"
tools: [Read, Write]
outputs: [structured.json]
schema: schemas/shorts.schema.json
approve:
  notes: { type: string, description: "Guidance for all shorts; may be empty" }
timeout: 15m
---

Propose the vertical shorts that can be cut from one recording session.

Read `in/transcribe/full.txt` (everything that was said) and
`in/transcribe/words.json` (for timestamps). Apply `in/context/shorts-craft.md`
(what makes a short, target length {{inputs.target_length}}) and
`in/context/voice.md` (how this channel talks).

Produce the structured output:

- `shorts[]` — each with
  - `slug` — kebab-case, ≤ 4 words, the *topic*, not the date
  - `angle` — one sentence: what this short is about and why someone stops
    scrolling
  - `source_ranges[]` — `{ "start", "end" }` seconds in the master clip
    where this was talked about; the b-roll will come from here
  - `format` — one of the formats named in `shorts-craft.md`
  - `strength` — 1–5

Propose everything that could work, ordered by strength, and be honest
about weak ones. The human deletes entries from this file before approving;
one recording usually holds one or two strong shorts, not ten. Do not
propose a "shortened version of the whole talk".
