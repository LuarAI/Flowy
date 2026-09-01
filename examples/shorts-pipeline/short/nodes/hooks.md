---
id: hooks
title: Hook options
mode: agent
needs: [transcribe, plan]
context:
  - ../context/shorts-craft.md
  - "{{inputs.brand_dir}}/voice.md"
tools: [Read, Write]
outputs: [hooks.md]
approve:
  chosen: { type: integer, required: true, description: "1-based index of the chosen hook" }
  notes:  { type: string, description: "Tweak to apply when developing the body" }
timeout: 10m
---

Write ten hook options for the short `{{item.slug}}`.

Read `in/_inputs.json` → `item` (the angle and where in the recording it
lives), `in/transcribe/full.txt` for what was actually said in those
ranges, `in/plan/approval.yaml` → `notes` from the human, and the hook
section of `in/context/shorts-craft.md`. Voice: `in/context/voice.md`.

Write `out/hooks.md`: ten numbered options, one per line, each ≤ 12 words,
in {{inputs.language}}. Vary the mechanism (number, contradiction, result,
question, confession) — no two hooks of the same kind in a row. After the
list, one line per hook saying which mechanism it uses.

The human picks one by index. Make them easy to compare.
