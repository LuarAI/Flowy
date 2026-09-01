# Flowy — notes for Claude Code

Read `AGENTS.md` first. It is the guide for any agent that authors, edits, or
debugs a Flowy workflow, and it applies to work on Flowy itself.

Then, depending on the task:

- Changing the format or runtime semantics → `SPEC.md` is the source of truth.
  Update it in the same change. `DECISIONS.md` records *why* things are the
  way they are; if you overturn a decision, edit it there and say why.
- Writing or fixing a workflow → `AGENTS.md` + the two examples in `examples/`.
- Wondering what already exists / why not use X → `docs/research.md`.
- Wondering what to build next → `docs/roadmap.md`.

Hard rules (from `DECISIONS.md`):

- Flowy spawns the user's own installed agent CLI. It never reads, stores, or
  forwards credentials, and never modifies the binary.
- Workflows are folders of files. Semantics live in markdown + YAML, never in
  the canvas file. The app is a viewer/runner over those files.
- This repository is public. No personal paths, names, emails, or private
  project details in examples, docs, or fixtures.
