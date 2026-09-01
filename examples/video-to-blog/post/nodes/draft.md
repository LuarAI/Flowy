---
id: draft
title: Draft post
mode: agent
needs: [fetch-transcript, extract-teachings]   # top-level nodes upstream of the foreach
context:
  - ../context/style.md
tools: [Read, Write]
outputs: [post.md]
approve:
  approved: { type: boolean, required: true }
  notes: { type: string, description: "Edits requested; used only on rerun" }
timeout: 15m
---

Draft one focused blog post for the teaching `{{item.slug}}`.

Read:

- `in/_inputs.json` → `item` (slug, title, claim, bucket, sources)
- `in/fetch-transcript/transcript.md` — the source of truth. Use only the
  parts the item's `sources` point to, plus immediate surroundings for
  accuracy.
- `in/extract-teachings/approval.yaml` → `notes` from the human, if any
- `in/context/style.md` — voice, structure, frontmatter, and the attestation
  rule: **never claim what the source does not contain**.

If `item.seed` is `true`, write a 3–5 line seed entry instead of a post, in
the seed format from the style guide.

Write `out/post.md` in {{inputs.language}} with the frontmatter the style
guide specifies. Set `date` to `{{run.started}}` (do not use the current
time). `sources` in the frontmatter must reference the transcript
timestamps you actually used, as `{video: <id from in/fetch-transcript/video.json>, at: "mm:ss"}`.

One idea per post. If the transcript does not support the claim, say so in
the first line of `out/post.md` as `<!-- UNSUPPORTED: reason -->` and keep
the post short; the human will skip it.
