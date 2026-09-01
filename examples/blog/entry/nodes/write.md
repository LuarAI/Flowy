---
id: write
title: Write the entry
mode: agent
needs: [outline, angles]
context:
  - ../context/topic-notes.md
  - ../context/voice.md
tools: [Read, Write]
outputs: [entry.md]
effort: high
approve:
  approved: { type: boolean, required: true }
  notes: { type: string, description: "Edits requested; used on rerun" }
timeout: 10m
---

Write the blog entry "{{item.title}}" following `in/outline/outline.md`
exactly — the structure was agreed with the human, do not rearrange it.

Substance comes from `in/context/topic-notes.md` only; the attestation rule
in `in/context/voice.md` applies. Voice and format per `voice.md`.

Write `out/entry.md` with the frontmatter the voice guide specifies
(`slug: {{item.slug}}`).
