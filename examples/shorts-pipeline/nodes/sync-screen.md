---
id: sync-screen
title: Sync screen recording
mode: script
needs: [transcribe]
run: python scripts/sync_screen.py
outputs: [offsets.json]
timeout: 15m
---

If `in/transcribe/media.json` lists a `screen` recording, compute its offset
from the master clip: predict from file timestamps, then **confirm by audio
cross-correlation**. Write `out/offsets.json`:

```json
{ "screen": { "path": "...", "offset_s": 12.84, "confidence": 0.97 } }
```

If there is no screen recording, write `{ "screen": null }` and exit 0.
Downstream nodes handle both cases.
