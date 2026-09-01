# Example: shorts pipeline

One recording session (a phone clip as master audio, optionally a screen
recording) becomes several vertical shorts. The agent proposes, the human
decides at three creative gates, records the voice-over, and polishes in
the editor. Everything else is automated.

This is the v2 target: it needs `chat` and `wait` modes, locks, pre-checks,
large-file references, and an editor adapter.

## Shape

```
transcribe (script, lock gpu) ──┐
sync-screen (script)            │
plan (agent, schema, gate: curate the list of shorts)
      │
   foreach short ──────────────────────────────────────────────┐
      │ hooks        agent · gate: pick one                     │
      │ body         chat  · develop the beat sheet + VO script │
      │ record-vo    wait  · human records                       │
      │ transcribe-vo script · lock gpu                          │
      │ edit-plan    agent · cut list + captions (portable)      │
      │ build-draft  script · lock editor · pre-check            │
      │ polish       wait  · human edits and exports             │
      │ titles       agent · gate: pick one                      │
      └────────────────────────────────────────────────────────┘
      │
wrap-up (agent) — publishing checklist across all shorts
```

## Inputs

| name | type | meaning |
|---|---|---|
| `session_dir` | path | folder with the raw clips (phone video = master audio; optional screen recording) |
| `brand_dir` | path | folder with `voice.md`, `titles-guide.md`, and a `music/` subfolder |
| `target_length` | string | e.g. `45s`; the sweet spot, not a hard limit |
| `language` | string | language of scripts, captions and titles |

## What this example demonstrates

- **Locks**: `gpu` (transcription and rendering must not overlap on one
  card) and `editor` (never write a project file while the editor is open).
- **Pre-checks** (`before:`) that block a node with a readable reason.
- **`chat` mode** for the one step that is a conversation by nature.
- **`wait` mode** for the two steps only the human can do.
- **Portable edit decisions** (`edit-plan` produces a cut list and captions
  in open formats) with the editor-specific draft generated last
  (`DECISIONS.md` D7). Swap `scripts/build_draft` and the pipeline moves to
  another editor.
- **Large media never copied**: the session clips are referenced (SPEC §4.2).
- A **downstream-of-foreach** node (`wrap-up`) that assembles a checklist
  once every short is done or skipped.

## Adapting it

The scripts are yours (`scripts/README.md` gives the contract). Replace
`context/shorts-craft.md` with your own formats, and point `brand_dir` at a
folder with your voice guide, title rules, and music. To make `body` a
headless gate instead of a conversation, change its `mode` to `agent` and
add an `approve:` block — nothing else changes.
