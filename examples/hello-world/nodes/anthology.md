---
id: anthology
title: Anthology
mode: agent
needs: [story]
tools: [Read, Write]
outputs: [anthology.md]
timeout: 5m
---

Assemble an anthology from the approved stories.

Each finished story is at `in/story/<slug>/draft/story.md`; skipped ideas
have `in/story/<slug>/status` containing `skipped` and no story. Write
`out/anthology.md`: a one-line title for the collection, then every story in
the order of `in/story/*/item.json` (`_index`), separated by a horizontal
rule. Do not edit the stories.
