# Decisions

The pre-committed calls, with the reason for each. If we change one, edit it
here and say why. Evidence behind most of these is summarised in
`docs/research.md`.

## D1 — Flowy spawns the user's own unmodified agent CLI. Never credentials.

Flowy runs `claude` (or `codex`, `gemini`, …) as found on the user's PATH,
with the user's own login, on the user's own machine. It never reads, stores,
forwards, or proxies OAuth tokens, keychain entries, or API keys; it never
bundles or patches the binary; it never runs the agent on anyone's behalf.

**Why:** Anthropic's Claude Code legal page permits exactly one thing for
subscription users: "an end user signing in to the unmodified Claude Code
binary with their own Claude subscription." It prohibits, and has enforced
against (April 2026), any tool that collects, stores, or intermediates
credentials. Headless `claude -p` still draws on the subscription as of
Sept 2026, after Anthropic paused a planned change on June 15, 2026. This is
the only viable path and it is also the honest one: the user is running
their own tool.

**Consequences:** no hosted version, ever. No "Claude Code" in the product
name. An API-key path must remain possible without a rewrite (see D3).

## D2 — The workflow is a folder of files. The app is a viewer over it.

Nodes are markdown with YAML frontmatter; the graph is `workflow.yaml`;
layout is a JSON Canvas file. Authoring happens wherever the user already
talks to their agent (editor, terminal, any chat). Flowy watches the folder
and re-renders. There is no authoring wizard and no chat inside Flowy.

**Why:** (a) The user's own agent must be able to create and fix workflows,
and it must be able to read what went wrong — files are the only interface
every agent already has. (b) Versioning, diffing, syncing and sharing come
free. (c) LLM agents solve only ~15% of node-graph *JSON* authoring tasks
(ComfyBench, CVPR 2025) — they hallucinate nodes and break structure — but
they are fluent in markdown and small YAML headers. So the authoring format
is prose-shaped and a compiler produces the executable manifest (as GitHub
Agentic Workflows and ComfyUI's workflow/API split do). (d) Every
database-backed tool we looked at (n8n, Flowise, Langflow, Dify) treats files
as export artifacts; that is the wrong way round for this use.

## D3 — Engine-agnostic at one altitude: "run headless in a directory, return files + cost."

Adapters implement `run(job) → events + result`. Claude Code first, Codex
second. Richer Claude-only features (hooks, subagent traces, permission
callbacks) sit behind capability flags and are never required.

**Why:** Every major agent CLI has a headless mode, but their event schemas
differ and none is a stable contract. Normalising at the file/cost level is
the only boundary that survives, and it is the hedge against D1's platform
risk: if subscription headless use changes, switching engine or auth is a
config change, not a rewrite.

## D4 — Gates are durable, file-based, and produce data.

A gate writes its outputs, then the runner exits. Approval is
`approval.yaml` with typed fields declared by the node; downstream nodes
consume it. The viewer's button, the CLI, and the human's agent editing the
file are equivalent. Humans may edit outputs in place while at a gate.

**Why:** Human-in-the-loop for *creative* checkpoints (pick the hook, approve
the body) does not exist in any video tool, and Claude Code's own Dynamic
Workflows explicitly declines it ("for sign-off between stages, run each
stage as its own workflow"). Durable-pause frameworks (Temporal, Inngest,
Windmill) agree on the pattern: externalise state, hold no process, zero
cost while waiting. Kestra's typed `onResume` inputs showed that approval is
better modelled as a data-producing step than a boolean. Locally, the
checkpoint file *is* the UI, which collapses two mechanisms into one.

## D5 — Every node run leaves a trace, a result, and a version; cache is a recursive input hash.

`runs/<run>/nodes/<id>/vN/` holds prompt, inputs, outputs, `trace.jsonl`,
`result.json` (cost, tokens, session id), and `signature.json`. `current`
selects the version. A node is cached when its signature matches and its
outputs still exist; it is stale when a context file or upstream output
changed.

**Why:** The original pain was a pipeline that works and is therefore never
looked at. Visibility of cost, inputs, and staleness is the fix. The
signature model is the one ComfyUI and marimo independently converged on
(hash the provenance, node ids excluded); Nextflow adds verify-on-resume;
Claude Code's Dynamic Workflows use the same "re-run from the first changed
prompt" rule. Traces are Flowy's own record because Claude Code documents its
session JSONL as internal and unstable.

## D6 — Concurrency is bounded (default 3) and locks are first-class.

**Why:** Subscription limits assume "ordinary, individual usage"; users
report throttling at 5–6 concurrent sessions even on top plans. Unbounded
fan-out is what gets a subscription rate-limited, and three parallel items
already transforms a sequential flow. Locks (`gpu`, `capcut`) come from real
gotchas: Whisper and NVENC starving each other on one GPU; an editor that
clobbers external writes to its project while open.

## D7 — Nodes exchange portable artifacts; tool-specific formats are adapters at the edges.

Between nodes: JSON, markdown, media files, and for edit decisions
OpenTimelineIO. Tool-specific outputs (a CapCut draft, a Word document) are
produced by the last node from a portable artifact.

**Why:** CapCut/JianYing began encrypting drafts in 2024; JianYing 7+ makes
round-trips impossible and only generation-only workflows survive. If the cut
list only exists inside editor-specific code, a vendor update ends the
pipeline. The same applies to any domain: keep the decision in an open
format, render to the tool last.

## D8 — Authoring format and execution format are separate.

`flowy compile` turns the folder into a frozen `manifest.json` per run.
The runner reads only the manifest. Validation errors are reported at
compile time with file and line.

**Why:** See D2(c). Also: freezing the manifest per run makes runs
reproducible while files are being edited, and gives the compiler one place
to catch an agent's mistakes before anything costs money.

## D9 — Determinism: nodes do not read the clock or roll dice.

`run.started` and `run.seed` are captured once per run and offered as
template values. Signatures exclude them.

**Why:** Copied from Claude Code Dynamic Workflows, which makes `Date.now()`
and `Math.random()` throw inside workflow scripts so replays are
reproducible. Cheap to adopt, expensive to retrofit.

## D10 — What Flowy does not build.

No Electron (local web server + browser runs on Windows and macOS alike).
No embedded chat (use `chat` mode, which opens the real agent CLI). No
auto-generated context files (research found LLM-generated context files
*reduced* success rates and raised cost >20%; instead Flowy makes context
size visible per edge). No CapCut round-trip. No re-implementation of what
Dynamic Workflows already does well; Flowy adds gates, canvas, versions, and
visibility.

## D11 — Not a business. Open source, MIT.

**Why:** Four well-known agent orchestrators (Vibe Kanban, Crystal, Terragon,
HumanLayer) shut down or went closed in H1 2026, citing no viable business
model, in a category of ~177 tools now competing with a free first-party
feature. Flowy is a local tool for its authors and their friends. MIT so
anyone can adopt the format or the adapters; the license can be revisited
before v1 if a reason appears.

## D12 — Stack: TypeScript. Python stays outside the core.

Node.js server + browser viewer (React Flow for the canvas), single
`npx`-style install. Domain scripts (Whisper, ffmpeg, draft generators) are
the user's own, invoked by script nodes.

**Why:** Cross-platform process spawning and a file watcher are the whole
runtime; TypeScript covers that and the viewer with one toolchain. Keeping
Python out of the core keeps the install small and keeps "bring your own
tools" honest.

## D13 — First real workflow: video → blog posts. Second: the shorts pipeline.

**Why:** The blog pipeline is fully headless, exercises fan-out (one video →
n posts), gates (skim before publish), and versioning, with no editor
dependency. The shorts pipeline is the richer *design* target (chat nodes,
wait nodes, locks, pre-checks, editor adapter) and is written up as an
example from day one so the format is proven against both on paper before
the runner exists.

## D14 — This repository is public.

No personal paths, real names, emails, private project details, or brand
internals in examples, docs, fixtures, or tests. Examples are anonymised
versions of real pipelines.

## D16 — Workflows are demonstrated, then crystallized — not authored cold.

The primary way a step comes into existence: the human has the conversation
(a `chat` node), the work gets done, and the conversation distills into a
**recipe** — the node's body, with the human's corrections folded in as
standing rules. Later runs execute the recipe headless; feedback reruns and
re-opened chats re-distill it. `continues:` gives a node the parent
conversation's memory via session forking, replay-stable because a re-run
parent yields a fresh session for branches to fork.

**Why:** the user's own hand-drawn exploration (2026-09): workflows in real
life start as chats wired to context, not as prompts written in advance.
Verbatim replay of the chat is brittle (corrections reference the old
batch); a distilled recipe is robust, reviewable (it is just the node file,
diffable in git) and keeps chat as the escape hatch — "teach it once, then
it just does it, and you can always re-teach." Recorded 2026-09-02.

## D15 — Pinned external facts to re-check before v1

- Claude Code `--bare` is slated to become the default for `-p`; bare mode
  cannot use subscription auth. The adapter must opt out explicitly.
- The June 15, 2026 Agent SDK / `claude -p` credit change is paused, not
  cancelled. Anthropic promised advance notice.
- Claude Code stream-json requires `--verbose`; costs in `result` are
  client-side estimates.
- SIGTERM to Claude Code exits 143 with no result; cancel with SIGINT.
