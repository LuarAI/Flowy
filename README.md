# Flowy

**Local, file-based workflows for your own agent CLI — with human gates,
parallel fan-out, versions, and a canvas that shows what's actually happening.**

> Status: **v0.1 — runner, CLI and viewer work.** Claude Code is the
> first engine (Codex and Gemini adapters are best-effort and untested).
> See `docs/roadmap.md` for what is and isn't there yet.

## Install

Requires Node 20+ and an agent CLI you are logged into (`claude`).

```sh
git clone https://github.com/LuarAI/Flowy.git
cd Flowy
npm install && npm run build
npm link            # puts `flowy` on your PATH (or use `node dist/cli.js`)
```

## Try it

```sh
flowy run examples/hello-world            # 1 Claude call: three story ideas, then a gate
flowy status examples/hello-world
flowy serve examples/hello-world          # open http://127.0.0.1:3579 — approve, rerun, compare there
```

Or from the terminal: `flowy approve ideas -d examples/hello-world --set notes="shorter"`,
then `flowy run examples/hello-world --run <id>` to continue.

Your agent can write workflows for you: point it at `AGENTS.md` and your
existing process notes.

## The idea

You already pay for one agent — Claude Code, Codex, Gemini CLI. It can do
almost any knowledge work: cut videos, draft posts, review documents, plan
courses. What it cannot do on its own is **repeat** a process on the next
input without you re-explaining it, run several instances **in parallel**
with only the context each one needs, **pause** where you make the creative
call, and **show** you the structure so you notice what's stale, bloated, or
wrong.

Flowy adds exactly that layer, and nothing else:

- A **workflow is a folder**: `workflow.yaml` + one markdown file per node.
  Your agent can write it, read it, and fix it — from whatever editor or chat
  you already use. Flowy watches the folder and renders it.
- Each node runs in an **isolated directory** with only its declared inputs.
  Video 1 and video 2 never see each other.
- **Gates** are first-class: a node can pause until you pick a hook, approve
  a draft, or record a voice-over. Approval is a small file; it costs nothing
  while waiting and survives reboots.
- **Fan-out**: one node lists ten ideas; ten items run as a checklist you can
  skip, rerun, or resume individually. Nothing gets lost behind the one you
  are working on.
- **Versions, cost, and staleness** per node. Edit a guideline file and see
  exactly which nodes it invalidates. Compare v2 and v3 side by side. Revert.
- **Your own tools**: script nodes call whatever you already use — Whisper,
  ffmpeg, a draft generator, pandoc. Flowy ships none of them.

It runs your **own installed** agent CLI with your own login. Flowy never
touches credentials and never talks to a model provider itself.

## What a node looks like

```markdown
---
id: hooks
mode: agent
needs: [transcribe, plan]
context: [context/voice.md]
outputs: [hooks.md]
approve:
  chosen: { type: integer, required: true }
  notes:  { type: string }
---

Write ten hook options for a vertical short.

Read `in/transcribe/full.txt` (what was said) and `in/plan/shorts.json`
(the angle). Follow `in/context/voice.md`. Write `out/hooks.md`, numbered,
each under 12 words, in {{inputs.language}}.
```

The human picks one; `approval.yaml` lands in the next node's inputs.

## Repository map

| File | What it is |
|---|---|
| [`SPEC.md`](SPEC.md) | The format and runtime contract. Source of truth. |
| [`DECISIONS.md`](DECISIONS.md) | Why things are the way they are. |
| [`AGENTS.md`](AGENTS.md) | Guide for an agent authoring or debugging a workflow. |
| [`docs/research.md`](docs/research.md) | What exists, what doesn't, and what we took from each. |
| [`docs/roadmap.md`](docs/roadmap.md) | v0 → v3. |
| [`examples/video-to-blog/`](examples/video-to-blog/) | A recorded talk → n blog posts, one per teaching. Headless with a skim gate. |
| [`examples/shorts-pipeline/`](examples/shorts-pipeline/) | A recording session → n vertical shorts, with hook/body gates, a record-your-voice wait, GPU and editor locks. |

## Who this is for

Anyone with a repeatable process and an agent subscription. The examples are
video, because that's where it started; the format doesn't care. A document
review, a research digest, a course outline, or a code migration is the same
shape: files in, prompt, files out, a human at the gates.

## License

MIT.
