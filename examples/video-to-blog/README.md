# Example: video → blog posts

A long-form talk or video diary entry becomes zero, one, or several focused
blog posts — **one per teaching**, not one per video. The human skims each
draft before it is published.

This is the v1 target workflow: fully headless except for one gate, with
fan-out and versioning, and no dependency on any editor.

## Shape

```
fetch-transcript (script)
      │
extract-teachings (agent, schema, gate: curate the list)
      │
   foreach post ─────────────────────────────┐
      │  draft   (agent, gate: approve/notes) │   ← one item per teaching
      │  publish (script)                     │
      └───────────────────────────────────────┘
      │
catalog (script) — regenerate the blog's index once all posts are in
```

## Inputs

| name | type | meaning |
|---|---|---|
| `video` | string | a video URL or id the transcript script understands |
| `blog_dir` | path | folder where published posts go |
| `language` | string | language of the *posts* (the video may be in another) |

## Run

```
flowy run examples/video-to-blog --input video=<url> --input blog_dir=/path/to/blog/posts
flowy status
# curate: delete teachings you don't want from out/structured.json, then
flowy approve extract-teachings --set notes="dropped the third one, too thin"
flowy run
# per post:
flowy approve draft --item post/<slug>
flowy rerun draft --item post/<slug> --feedback "less hedging, keep the number"
```

## What this example demonstrates

- `script` nodes calling the user's own tools (`scripts/README.md` lists the
  contract; the scripts themselves are yours).
- A **schema** output feeding a **foreach**.
- **Editing outputs at a gate** as the curation mechanism (SPEC §3.2) — the
  human prunes the teachings list before any post is drafted.
- Per-item gates with **feedback reruns** that resume the same session.
- A node **downstream of a foreach** (`catalog`) that waits for every item.
- The **attestation rule** in `context/style.md`: a post may never claim
  what its source does not contain — the transcript is the source of truth.

## Adapting it

Point `blog_dir` at your own posts folder, replace `context/style.md` with
your style guide, and make `scripts/fetch_transcript` produce
`out/transcript.md` from whatever your source is (a YouTube id, a local
recording run through Whisper, a podcast RSS entry). Nothing else changes.
