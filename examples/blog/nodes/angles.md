---
id: angles
title: Mine the notes for angles
mode: agent
context:
  - context/voice.md
tools:
  - Read
  - Write
outputs:
  - structured.json
schema: schemas/angles.schema.json
approve:
  notes:
    type: string
    description: Guidance for all entries; may be empty
timeout: 10m
---

Find the strongest blog-entry angles in the notes about: {{inputs.topic}}.

Read `in/context/topic-notes.md` (the only source of substance — entries
may not claim what it does not support) and the "one idea per entry" rule
in `in/context/voice.md`.

Produce the structured output: `angles[]`, each with

- `slug` — kebab-case, 2–4 words
- `title` — working title, ≤ 60 characters
- `claim` — the one idea, stated in one sentence
- `supported_by` — which bullet(s) of the notes carry it, quoted briefly

Propose between 2 and 5, ordered by strength. Be honest: thin support means
it does not make the list. The human deletes angles from this file before
approving, so make each entry self-explanatory.
