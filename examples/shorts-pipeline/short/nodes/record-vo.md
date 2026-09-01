---
id: record-vo
title: Record the voice-over
mode: wait
needs: [body]
outputs: [vo.m4a]
hint: "Record the script in in/body/script.md in one take; drop the file here as vo.m4a"
---

The human records the approved script. Read it from `in/body/script.md`.
If it is a loop short, record the joined seam sentence in one breath — the
cut happens in the edit, so the seam inherits natural intonation.

Drop the recording into this node's `out/` as `vo.m4a`. The node completes
when the file appears.
