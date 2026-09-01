---
id: draft
title: Draft the story
mode: agent
needs: [ideas]
tools: [Read, Write]
outputs: [story.md]
approve:
  approved: { type: boolean, required: true }
  notes: { type: string }
timeout: 5m
---

Write a complete short story of at most 120 words for the idea
"{{item.title}}": {{item.premise}}

Read `in/ideas/approval.yaml`; if `notes` is set, follow it. Write the story
to `out/story.md` with the title as a first-level heading and nothing else
in the file.
