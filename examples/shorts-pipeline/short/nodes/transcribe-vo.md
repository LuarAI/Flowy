---
id: transcribe-vo
title: Transcribe voice-over
mode: script
needs: [record-vo]
run: python "{{workflow.scripts}}/transcribe.py" "in/record-vo/vo.m4a"
outputs: [words.json, full.txt, media.json]
lock: gpu
timeout: 15m
---

Word-level transcription of the recorded voice-over, same script and same
output shape as the session transcription. The VO word times drive every
beat boundary and every caption in the edit plan, so the word-level file is
the one that matters here.
