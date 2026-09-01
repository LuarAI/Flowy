# Style guide (placeholder — replace with your own)

This file is read by the `extract-teachings` and `draft` nodes. It is a
generic stand-in so the example runs; the real value comes from replacing it
with the guide you already use.

## What counts as a teaching

- One idea a reader could act on, or that changes how they see something.
- Stated in one sentence without the word "and".
- Supported by what was actually said. A good anecdote is not a teaching
  unless it carries one.
- Buckets: `build-in-public`, `method`, `teardown`.

## Voice

- Honest and specific. Real numbers where they were given.
- One idea per post. If a second idea appears, it is a second post.
- Distilled from the source, not transcribed. No filler, no "in this video".
- Write in the reader's language; translate quotes faithfully and mark them
  as translated.

## Attestation rule

The source is the truth. A post may be refined any time, but it may never
claim something the source does not contain. When in doubt, quote and cite
the timestamp rather than paraphrase.

## Post format

```markdown
---
title: ...
description: one sentence, ≤ 160 characters
bucket: build-in-public | method | teardown
date: <run start time; the draft node is told the value>

sources:
  - { video: <id>, at: "12:41" }
---

<body: 400–900 words, headers optional, ends without a summary paragraph>
```

## Seed format

```markdown
---
title: ...
seed: true
sources: [{ video: <id>, at: "mm:ss" }]
---

<3–5 lines: the idea, why it is not yet a post, what would make it one>
```
