---
id: extract-teachings
title: Extract teachings
mode: agent
needs: [fetch-transcript]
context: [context/style.md]
tools: [Read, Write]
outputs: [structured.json]
schema: schemas/teachings.schema.json
approve:
  notes: { type: string, description: "Anything the drafts should know; may be empty" }
timeout: 15m
---

Identify the distinct **teachings** in a video transcript. A teaching is one
idea a reader could act on or be changed by, stated in one sentence. A video
yields zero, one, or several. Weak material yields zero — do not pad.

Read `in/fetch-transcript/transcript.md` (source of truth, may be in a
different language than {{inputs.language}}) and `in/fetch-transcript/video.json`.
Apply the "what counts as a teaching" section of `in/context/style.md`.

Produce the structured output described by the schema:

- `teachings[]` — each with:
  - `slug` — kebab-case, ≤ 5 words, stable and searchable
  - `title` — working title in {{inputs.language}}, ≤ 70 characters
  - `claim` — the teaching in one sentence, in {{inputs.language}}
  - `bucket` — one of the buckets listed in the style guide
  - `sources[]` — transcript timestamps (`mm:ss`) that support it, with a
    short quote each. Every teaching needs at least one.
  - `seed` — `true` if this is a first mention of an idea not yet
    essay-worthy (it will be recorded, not drafted)

Order by strength. The human will delete entries from this file before
approving; make each entry self-explanatory so that is easy.
