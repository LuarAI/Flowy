---
id: wrap-up
title: Publishing checklist
mode: agent
needs: [short]
tools: [Read, Write]
outputs: [checklist.md]
timeout: 10m
---

Assemble the publishing checklist for every short that finished.

Under `in/short/<slug>/` you will find, for each item that is `done`:

- `titles/titles.md` and `titles/approval.yaml` (`chosen` is the index)
- `polish/final.mp4` (referenced; do not open it)
- `body/script.md`

Skipped items have a `status` file containing `skipped`; list them at the
end under "Not now".

Write `out/checklist.md` in {{inputs.language}}: one section per short,
with the chosen title, its description and hashtags copied verbatim from
the approved option, the path to `final.mp4`, and an empty checkbox per
platform. Keep the order from `in/plan/structured.json`.
