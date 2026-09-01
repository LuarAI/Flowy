# Example: blog

Text only, no scripts. Raw notes about a topic become blog entries:

```
angles (agent · schema · gate: curate the list)
   │
 foreach entry ──────────────────────────────┐
   │  outline  chat  · refine the structure  │   ← the back-and-forth step
   │  write    agent · gate: approve/notes   │     (effort: high)
   └─────────────────────────────────────────┘
   │
index (agent · model: haiku — cheap assembly on a small model)
```

This is the sandbox for improving Flowy on the go: everything is small,
fast, and costs a few cents of quota per full pass.

## Run it

```
flowy run examples/blog                      # mines the notes, pauses at the gate
flowy serve examples/blog                    # curate + approve in the browser
flowy approve angles -d examples/blog --set notes="shorter, punchier"
flowy run examples/blog --run <id>           # entries start; each pauses at its outline chat
flowy chat outline -d examples/blog --item entry/<slug>   # refine structure, agent writes outline.md
flowy run examples/blog --run <id>           # write drafts -> approve each -> index
```

Shortcut if you don't want the conversation on some entry: open the item's
`outline` in the viewer, or drop an `outline.md` into its `out/` yourself
and it counts as done.

## What it demonstrates

- Context as files: `context/topic-notes.md` is the substance,
  `context/voice.md` the style. Improve those, and the stale markers show
  exactly which nodes need a re-run.
- A `chat` node in the middle of a pipeline — the structure conversation —
  feeding an `agent` node that then works alone.
- Per-node `model:`/`effort:`: expensive writing on high effort, cheap
  assembly on `haiku`.
- The angles gate as curation: delete entries from `structured.json`
  before approving; add your own by hand if you like.

## Make it yours

Replace the two context files, change the `topic` input, and raise
`maxItems` in `schemas/angles.schema.json` if your notes are rich.
