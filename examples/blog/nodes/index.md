---
id: index
title: Build the index
mode: agent
needs: [entry]
tools: [Read, Write]
outputs: [index.md]
model: haiku
timeout: 5m
---

Build the index of finished entries.

Each approved entry is at `in/entry/<slug>/write/entry.md`; skipped angles
have `in/entry/<slug>/status` containing `skipped`. Write `out/index.md`:
one line per finished entry — title as a link to `<slug>.md`, then the
`description` from its frontmatter — in the order of `in/entry/*/item.json`
(`_index`). List skipped angles at the end under "Parked". Copy text
verbatim; this node runs on a small model on purpose.
