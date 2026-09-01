---
id: body
title: Develop the body
mode: chat
needs: [hooks, transcribe, plan]
context:
  - ../context/shorts-craft.md
  - "{{inputs.brand_dir}}/voice.md"
tools: [Read, Write]
outputs: [script.md]
---

We are developing the beat sheet and voice-over script for the short
`{{item.slug}}`, starting from the hook the human chose: `in/hooks/approval.yaml`
gives the index (`chosen`) and any tweak (`notes`); the hook text itself is
that line of `in/hooks/hooks.md`.

Read `in/transcribe/full.txt` for the source material in the item's ranges
(`in/_inputs.json`), and `in/context/shorts-craft.md` for structure, target
length {{inputs.target_length}}, and the loop-short technique if the
format calls for it.

Propose a first beat sheet (4–7 beats, each with: what is said, what is on
screen, source range for b-roll), then iterate with me. When we agree,
write `out/script.md` with:

1. The final voice-over script in {{inputs.language}}, one paragraph per
   beat, marked for breath and emphasis, ready to record in one take.
2. The beat table: beat · VO line · visual · source range (seconds).
3. If it is a loop short: the joined seam sentence, and which half opens
   and which closes.

Do not write the file until I say we are done.
