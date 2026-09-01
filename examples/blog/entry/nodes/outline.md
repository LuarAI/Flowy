---
id: outline
title: Refine the structure together
mode: chat
needs: [angles]
context:
  - ../context/topic-notes.md
  - ../context/voice.md
tools: [Read, Write]
outputs: [outline.md]
hint: "flowy chat outline --item entry/<slug> — refine the structure, then have it write outline.md"
---

We are shaping the entry "{{item.title}}" — the claim: {{item.claim}}

Read `in/context/topic-notes.md` (especially: {{item.supported_by}}) and
`in/angles/approval.yaml` for the human's notes.

Propose a structure first: the opening line, 3–5 sections with one sentence
each on what they carry, and what the entry deliberately leaves out. Then
iterate with me — push back where my suggestions would break the "one idea"
rule. When we agree, write `out/outline.md` with the final structure and
any phrasing we settled on. Do not write it until I say we are done.
