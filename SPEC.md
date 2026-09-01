# Flowy specification

**Status:** v0 — draft, nothing runs yet. This document is the contract the
runner and the viewer will be built against. Change it before changing code.

Flowy is a local runner and viewer for workflows that are **folders of
files**. Each node is one file. Agent nodes run the user's own installed
CLI agent (Claude Code, Codex, …) headlessly, in an isolated working
directory containing only that node's inputs. The canvas is a *view* of the
folder; it never holds semantics.

Vocabulary used throughout:

| Term | Meaning |
|---|---|
| **workflow** | a folder containing `workflow.yaml` and `nodes/*.md` |
| **node** | one step; one markdown file with YAML frontmatter |
| **run** | one execution of a workflow with concrete inputs; lives in `runs/<run-id>/` |
| **version** | one attempt at a node inside a run (`v1`, `v2`, …); the `current` one feeds downstream |
| **gate** | a node that pauses after producing outputs until a human approves |
| **item** | one instance of a fan-out (`foreach`) sub-workflow |
| **engine** | an adapter that runs an agent CLI headlessly |
| **manifest** | the compiled, frozen execution graph for a run |

---

## 1. The workflow folder

```
my-workflow/
  workflow.yaml          # graph, inputs, engine defaults, concurrency, locks
  nodes/                 # one file per node
    transcribe.md
    plan.md
    ...
  context/               # optional: files nodes may read (guidelines, glossaries)
  scripts/               # optional: commands used by script nodes and pre-checks
  layout.canvas          # optional: JSON Canvas with positions only (§10)
  <sub-workflow>/        # optional: nested workflow folders used by foreach
  runs/                  # runtime state, gitignored (§6)
```

Everything under `runs/` is produced by Flowy. Everything else is authored by
a human or their agent and is meant to live in version control.

### 1.1 `workflow.yaml`

```yaml
flowy: 0                      # spec version this file targets (integer)
name: shorts-pipeline
description: One recording session -> N vertical shorts, with approval gates.

inputs:                       # declared run inputs; provided at `flowy run`
  session_dir:   { type: path, required: true, description: "Folder with the raw clips" }
  brand_dir:     { type: path, required: true }
  target_length: { type: string, default: "45s" }
  language:      { type: string, default: "es" }

engine:
  default: claude             # engine used by agent nodes unless overridden
  claude:
    model: null               # null = the CLI's default
    effort: null
    permission_mode: dontAsk  # never leave unset (§8.1)

concurrency: 3                # max nodes running at once, across all items
locks:                        # named resources; number = how many holders at once
  gpu: 1
  capcut: 1

nodes:                        # ordered list; order is cosmetic, edges come from `needs`
  - transcribe
  - plan
  - foreach: plan.shorts      # fan-out (§5)
    id: short
    workflow: ./short
    concurrency: 2
  - wrap-up
```

Rules:

- Every entry in `nodes:` is either a node id (a file `nodes/<id>.md` must
  exist) or a `foreach` block.
- `inputs` types: `string`, `number`, `boolean`, `path`, `list`. `path` inputs
  are resolved to absolute paths at run start and recorded in `run.yaml`.
- Unknown top-level keys are an error. Unknown keys under `engine.<name>` are
  passed through to that adapter.

### 1.2 Node files: `nodes/<id>.md`

A node is YAML frontmatter plus a markdown body. The body is the prompt (for
`agent` and `chat` nodes) or a human-facing description (for `script` and
`wait` nodes).

```markdown
---
id: hooks
title: Hook options
mode: agent                     # agent | script | wait | chat
needs: [transcribe, plan]       # upstream node ids (edges in)
context:                        # read-only files made available in ./in/context/
  - context/voice.md
  - "{{inputs.brand_dir}}/style-guide.md"
tools: [Read, Write]            # engine tools the node may use (agent/chat only)
outputs: [hooks.md]             # files the node must produce in ./out/
schema: null                    # optional JSON schema for a structured output (§4.1)
approve:                        # optional: makes this node a gate (§3)
  chosen: { type: integer, required: true, description: "Index of the chosen hook" }
  notes:  { type: string }
lock: null                      # optional named lock (§7)
timeout: 15m
cache: inputs                   # inputs | never   (§6.3)
before: []                      # optional pre-check commands (§7.2)
engine: null                    # override workflow default (agent/chat only)
---

You are writing hook options for a vertical short.

Inputs are in `./in/`. Read `in/transcribe/full.txt` (what was said) and
`in/plan/shorts.json` (the angle for this short). Write exactly ten hook
options to `out/hooks.md`, numbered, each under 12 words, in {{inputs.language}}.
```

Field reference:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | must equal the filename without `.md`; `[a-z0-9-]+` |
| `title` | no | display name; defaults to `id` |
| `mode` | yes | `agent`, `script`, `wait`, `chat` (§2) |
| `needs` | no | upstream ids in the same workflow; inside a nested workflow, also any top-level node not downstream of the foreach (§5) |
| `context` | no | files or folders; paths relative to the node's own workflow folder (`../context/x.md` reaches a parent's), or `{{inputs.*}}` templates. Folders are included recursively; prefer files. |
| `tools` | no | engine-specific tool allowlist; default `[Read, Write]` |
| `outputs` | yes for `agent`/`script`/`wait`/`chat` | filenames relative to `./out/`; may include folders (`captions/`) and globs (`*.md`) — a glob must match ≥1 file |
| `schema` | no | path to a JSON schema; output written to `out/structured.json` |
| `approve` | no | presence makes the node a gate; keys are the fields the approver produces |
| `lock` | no | name declared under `locks:` in `workflow.yaml` |
| `timeout` | no | default `30m`; `wait` nodes ignore it |
| `cache` | no | default `inputs` |
| `before` | no | list of commands run before the node; non-zero exit → `blocked` |
| `engine` | no | `claude`, `codex`, `gemini`, … |
| `model` | no | engine model override for this node (e.g. `haiku`, `opus`); agent/chat only |
| `effort` | no | engine effort override for this node; agent/chat only |
| `run` | `script` only | the command to execute (§2.2) |
| `hint` | `wait` only | one line shown to the human |

Templates: the body and string fields (`context`, `run`, `before`) may use
`{{inputs.<name>}}`, `{{run.id}}`, `{{run.started}}` (ISO timestamp captured
at run start), `{{run.seed}}` (integer captured at run start),
`{{workflow.dir}}` and `{{workflow.scripts}}` (absolute paths of the node's
workflow folder and its `scripts/`), and inside a foreach item,
`{{item.<field>}}`. Nothing else is templated; context files are copied
verbatim. Nodes must not derive time or
randomness themselves; they take it from `run.*` so replays are reproducible.

---

## 2. Node modes

All modes share the same working-directory contract (§4): the runner
materialises `./in/` and an empty `./out/`, the node produces the files
declared under `outputs`, and the runner verifies they exist.

### 2.1 `agent`

Runs the engine headlessly with the node body as the prompt. Completes when
the engine exits successfully **and** every declared output exists. If the
engine exits 0 but an output is missing, the node fails with
`missing_output`. The engine is invoked with the version directory as its
working directory and sees nothing outside it (except explicitly referenced
large media, §4.2).

### 2.2 `script`

Runs `run:` as a shell command in the version directory with environment:

```
FLOWY_IN, FLOWY_OUT, FLOWY_NODE, FLOWY_RUN, FLOWY_WORKFLOW, FLOWY_SCRIPTS,
FLOWY_FOREACH and FLOWY_ITEM (inside an item),
FLOWY_INPUT_<NAME> (one per declared input, uppercased)
```

Completes on exit 0 with outputs present. Stdout/stderr are captured to the
version dir. `run:` is executed by the platform shell — PowerShell 7 (`pwsh`)
if installed, else `cmd.exe`, on Windows; `bash -lc` elsewhere; override
with `FLOWY_SHELL`. Because the working directory is the version directory,
refer to your own scripts as `"{{workflow.scripts}}/name.py"`. Keep commands
portable or provide both via `run: { windows: ..., posix: ... }`.

A script node may also write `out/_meta.json` with free-form structured
metadata (e.g. durations, checksums). The runner copies it into `result.json`
under `meta`, so the trace and the viewer can show it. This is the reverse
channel: scripts stream facts back, not only files.

### 2.3 `wait`

No engine, no command. The node is a human action: record the voice-over,
export the video, drop a PDF. It completes when all declared outputs exist in
`./out/` (the runner polls and also reacts to filesystem events). `hint` is
shown in the viewer and printed by `flowy status`. Timeout does not apply.

### 2.4 `chat`

An interactive session instead of a headless run. `flowy chat <node>` opens
the engine's interactive CLI in the version directory with the body as the
opening message (or resumes an existing session, §3.3). The human works with
the agent until the outputs exist, then closes the session or runs
`flowy done <node>`. Use `chat` when the step is a conversation by nature
("develop the body with me"), not for review — reviews use `approve` on an
`agent` node.

---

## 3. Gates (`approve`)

Any node with an `approve:` block pauses after its outputs are verified. Its
status becomes `gate`. Nothing downstream of it runs until approval.

### 3.1 Approval is data

Approval is a file: `approval.yaml` inside the node's current version
directory, with the fields declared under `approve:`, plus metadata the runner
adds:

```yaml
chosen: 3
notes: "Shorter. Lead with the number."
_approved_at: 2026-09-01T14:02:11Z
_approved_by: local
```

Downstream nodes receive it as `in/<node-id>/approval.yaml`. So "pick a hook"
is not a checkbox — it produces the data the body node needs.

The file is written by `flowy approve <node> --set chosen=3 --set notes="..."`,
by the viewer's approve button, or by the human's own agent editing the file.
All three are equivalent; the runner only checks the file.

### 3.2 Editing outputs during a gate

While a node is at `gate`, the human may edit files in its `out/` directly
(delete unwanted items from a list, fix a title). Approval snapshots output
hashes; the edited state is what downstream sees and what the cache signature
records. This is deliberate: curation is cheaper than re-prompting.

### 3.3 Rejecting

`flowy rerun <node> --feedback "…"` creates a new version. The feedback is
saved as `feedback.md` in the new version and appended to the prompt under a
`## Feedback on the previous attempt` heading, together with the previous
outputs under `in/_previous/`. For agent nodes the runner passes the previous
version's session id to the engine when the engine supports resume, so the
conversation continues rather than restarts. `flowy chat <node>` on a gated
agent node resumes that session interactively.

### 3.4 Durability

A pending gate holds no process. When no node is runnable, the runner exits;
`flowy run` (or the viewer's file watcher) resumes from the run folder. A gate
survives reboots, costs nothing while waiting, and can be approved from
another machine that syncs the folder.

---

## 4. The working directory contract

Each version of a node executes in its own directory:

```
runs/<run-id>/nodes/<node-id>/v3/
  in/
    _inputs.json          # resolved run inputs + item (if any)
    context/              # the node's `context:` files. Workflow-relative paths keep
                          # their layout minus the leading `context/` or `../`;
                          # templated/absolute paths land at in/context/<basename>.
                          # Two entries resolving to the same name = compile error.
    <upstream-id>/        # current version outputs of each `needs` entry
      <files…>
      approval.yaml       # if that upstream was a gate
    _previous/            # on rerun: previous version's out/ (§3.3)
    _refs.json            # large media referenced, not copied (§4.2)
  out/                    # the node writes here; verified against `outputs`
  prompt.md               # the exact final prompt sent (templates resolved)
  feedback.md             # on rerun
  approval.yaml           # on gates, once approved
  trace.jsonl             # normalised engine/script events (§9)
  result.json             # normalised result (§9)
  stdout.log / stderr.log
  signature.json          # cache signature parts (§6.3)
```

### 4.1 Structured outputs

If `schema:` is set, agent engines that support structured output are asked
for it (Claude: `--json-schema`). The result is written to
`out/structured.json` and validated against the schema; validation failure
fails the node with `schema_invalid`. Fan-out (`foreach`) reads arrays from
structured outputs by path: `foreach: plan.shorts` means
`out/structured.json` of node `plan`, key `shorts`. If a node has no schema,
`foreach: plan.shorts` falls back to `out/shorts.json`.

### 4.2 Large files

`in/` is materialised with hard links where the filesystem allows, else
copies. Files larger than `link_threshold` (default 64 MB) that cannot be
linked are **not copied**; they are listed in `in/_refs.json` with absolute
paths, and the engine is granted read access to their containing folders
(Claude: `--add-dir`). A 2 GB recording never moves. Files above the
threshold enter the cache signature by size and modification time rather
than content hash.

### 4.3 Isolation

The engine's working directory is the version directory. There is no
`.claude/`, `.mcp.json`, or `AGENTS.md` in it unless the node's `context:`
puts one there on purpose. Agent nodes therefore see: the prompt, `in/`, and
their allowed tools. That is the whole point.

---

## 5. Fan-out (`foreach`)

```yaml
- foreach: plan.shorts       # array source: <node>.<key>
  id: short                  # name of this fan-out; items live under items/short/
  workflow: ./short          # nested workflow folder, same format
  key: slug                  # field of each item used as the item id (default: index)
  concurrency: 2             # max items running at once (bounded by global concurrency)
```

- Width is decided at run time from the array. Each element becomes an item.
  Item ids come from `key` (slugified) or the 1-based index. A nested
  workflow declares only `flowy`, `name`, `description`, `nodes`; it cannot
  contain a `foreach` of its own in this version.
- Each item runs the nested workflow with `inputs` = parent inputs plus
  `item` = the element. Nested nodes reference it as `{{item.slug}}` and read
  it in `in/_inputs.json`.
- Items live in `runs/<run-id>/items/<foreach-id>/<item-id>/` with the same
  `nodes/<id>/vN/` structure. Items are independent: gates, versions and
  reruns are per item.
- Nodes inside the nested workflow may list in `needs:` any **top-level**
  node that is not itself downstream of this foreach. They receive its
  current outputs as `in/<id>/` exactly like a sibling, and the foreach
  implicitly waits for every top-level node its nested nodes reference. The
  compiler rejects references to nodes downstream of the foreach (a cycle)
  and to nodes inside another foreach. Nested ids and top-level ids share
  one namespace within a workflow tree; collisions are compile errors.
- A node downstream of a foreach (`needs: [short]`) receives
  `in/short/<item-id>/<nested-node>/…` for every item that is `done` or
  `skipped`, and runs only when no item is still pending.
- `flowy skip <foreach>/<item-id>` marks an item `skipped`. Skipped items
  persist across reruns of the parent; they are the "not now" pile, not a
  deletion. The viewer shows a foreach as a checklist of items with status.
- If the source array changes on a rerun of the upstream node, existing items
  whose key still appears are kept (with their versions); new keys are added;
  keys that disappeared are marked `orphaned` and never run again unless the
  key returns.

---

## 6. Runs, versions, and cache

### 6.1 Run folder

```
runs/<run-id>/
  run.yaml          # inputs (resolved), started, seed, engine versions, status
  manifest.json     # compiled graph (§11); frozen for the run
  nodes/<id>/       # top-level nodes
    v1/ v2/ …
    current         # text file containing the current version name, e.g. "v2"
  items/<foreach-id>/<item-id>/
    nodes/<id>/…
    status          # pending | running | done | skipped | orphaned
```

`run-id` defaults to `<UTC date>_<short random>` and can be set with
`--run <id>`. Running a workflow again with `--run <existing>` resumes it.
`current` is a plain file, not a symlink, so the layout works on every
filesystem and syncs through Dropbox-like tools.

### 6.2 Versions

Every execution of a node creates `vN` (N increments, never reused). The
`current` file selects which version feeds downstream and is shown by
default. `flowy use <node> v2` repoints it; downstream nodes become `stale`.
Versions are never deleted by the runner.

### 6.3 Cache signature

A node's signature is a hash of:

- the node file (frontmatter + body) after template resolution,
- the resolved engine config that affects output (engine name, model, effort),
- hashes of every `context:` file,
- hashes of every input file under `in/` from upstream **current** versions
  (which already embed *their* signatures — the signature is recursive),
- the item object (inside a foreach),
- for script nodes: the `run:` string and hashes of files under `scripts/`
  that it references (best effort: any path token that exists on disk).

Excluded on purpose: `run.started`, `run.seed`, timestamps, the run id.

On `flowy run`, a node is skipped as `cached` when its current version's
`signature.json` matches **and** every declared output still exists (verify
on resume — a hash hit is necessary, not sufficient). Otherwise a new version
runs. `cache: never` always runs. This is the ComfyUI / marimo model: hash the
provenance, re-run from the first node whose inputs changed, plus everything
downstream.

### 6.4 Stale

A node is `stale` when its current version's signature no longer matches what
its inputs would produce now. Stale nodes are not re-run automatically; the
viewer marks them and `flowy run` re-runs them. Editing a guideline file
therefore visibly invalidates exactly the nodes that read it.

---

## 7. Scheduling, concurrency, locks, pre-checks

### 7.1 Scheduler

- Topological order over the manifest. A node is `ready` when every `needs`
  entry is `done`, `cached`, or (for foreach) fully resolved.
- At most `concurrency` nodes run at once, counting nodes inside items.
- Each `foreach` has its own `concurrency` cap, applied within the global one.
- Sibling agent nodes start staggered by `stagger` (default 5 s) so the first
  one warms the engine's prompt cache for the rest.
- `flowy run --until <node>` runs the minimal subgraph needed to complete
  `<node>` and stops.

### 7.2 Locks and pre-checks

`lock: gpu` acquires the named lock for the node's whole execution. Locks
are counting semaphores declared in `workflow.yaml`. Typical uses: one GPU
job at a time; only one process writing to an editor's project folder.

`before:` runs each command in order in the version directory before
starting the node. The first non-zero exit sets status `blocked` with the
command's stderr as the message. Blocked nodes are retried on the next
`flowy run`. Use it for "the editor must be closed" and "the disk must have
space" checks. These commands are not cached and not part of the signature.

### 7.3 Cancellation

`flowy stop` sends SIGINT (or the platform equivalent) to running engines and
waits up to 30 s for a clean result before killing. A killed agent version is
marked `interrupted` and produces no result; the next run creates a new
version. Never SIGTERM Claude Code: it exits 143 with no result recorded.

---

## 8. Engines

An engine adapter implements one operation:

```
run(job) -> stream of events + Result
job = { cwd, prompt, tools, schema?, timeout, resume_session?, add_dirs[], model?, effort? }
```

and one optional operation, `interactive(job)`, used by `chat` mode.

Events are normalised into Flowy's envelope (§9). Anything richer than
"prompt in, files and cost out" — hooks, subagent trees, permission callbacks
— is exposed through capability flags and never required by the runner.

### 8.1 Claude Code

```
claude -p "<prompt>" \
  --output-format stream-json --verbose --include-partial-messages \
  --permission-mode dontAsk \
  --allowedTools <tools> \
  --strict-mcp-config \
  [--json-schema <inline JSON>] [--resume <session>] [--add-dir <dir>]... \
  [--model <m>] [--effort <e>]
```

The prompt is passed on stdin (command-line length limits). On Windows the
adapter runs the package's `cli.js` with the current Node binary rather than
the `.cmd` shim, so JSON arguments survive without shell quoting; if that
file is not found it falls back to the shim through the shell and asks for
the structured output in the prompt instead of `--json-schema`.
`engine.claude` accepts `bin`, `model`, `effort`, `permission_mode`,
`partial` (stream partial messages into the trace) and `extra_args`.
`engine.env_unset` (list) removes variables from the child environment —
the only environment manipulation Flowy performs, and it never adds any.

Non-negotiable rules (see `DECISIONS.md` D1):

1. Invoke the `claude` binary found on the user's PATH (or `engine.claude.bin`).
   Never bundle, patch, or wrap it in anything that alters its behaviour.
2. Never read, copy, log, or transmit credentials: not
   `~/.claude/.credentials.json`, not the OS keychain, not
   `CLAUDE_CODE_OAUTH_TOKEN`, not `ANTHROPIC_API_KEY`. Environment is passed
   through; Flowy neither injects nor strips auth. The one exception is
   session identity: when Flowy itself runs inside a Claude Code session
   (an agent driving `flowy run`), the CLI refuses to nest, so the adapter
   removes the session-marker variables (`CLAUDECODE`,
   `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`,
   `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_PID`) from
   the child environment. `engine.claude.inherit_session: true` disables
   that.
3. `--permission-mode` is always set explicitly. The default is *Manual* even
   for `-p`, which would hang a headless node.
4. `--bare` is **not** used: bare mode ignores subscription auth and requires
   an API key. If a future CLI makes bare the default for `-p`, the adapter
   must opt out explicitly. Track the changelog.
5. Session ids from `result.session_id` are stored in `result.json` and used
   for `--resume` on reruns and `chat`. Session transcripts under
   `~/.claude/projects/` are **not** parsed: the format is documented as
   unstable. `trace.jsonl` is Flowy's own record.

Capabilities: `structured_output`, `resume`, `thinking`, `subagent_trace`,
`cost`.

### 8.2 Others

- **Codex CLI** (verified with codex-cli 0.148): `codex exec --json
  --skip-git-repo-check -C <cwd> --output-last-message out/_last.md
  --sandbox workspace-write [--output-schema schema.json] [--add-dir …] -`
  with the prompt on stdin. Structured output uses `--output-schema`; the
  final message is parsed as JSON. Capabilities: `structured_output`,
  `resume`, `cost` (token counts only — no dollar estimate). Config:
  `bin`, `model`, `sandbox`, `extra_args`.
- **Gemini CLI**: `gemini -p --output-format stream-json`. Capabilities: `cost`.
- **Generic**: `engine.custom.command` with `{prompt}`/`{cwd}` placeholders;
  no capabilities; result is exit code + outputs.

Adapters live in `engines/<name>/`. Adding one must not touch the runner.

---

## 9. Traces and results

`trace.jsonl` — one JSON object per line, Flowy's envelope:

```json
{"t":"2026-09-01T14:00:03.120Z","type":"tool_use","engine":"claude","payload":{...raw event...}}
```

`type` ∈ `start`, `text`, `thinking`, `tool_use`, `tool_result`, `retry`,
`subagent`, `stdout`, `stderr`, `end`. `payload` is the engine's raw event,
unmodified. The viewer renders the envelope; anyone debugging a node can read
the raw payload.

`result.json`:

```json
{
  "node": "hooks", "version": "v3", "mode": "agent", "engine": "claude",
  "status": "done",
  "started": "...", "ended": "...", "duration_ms": 41200,
  "exit_code": 0, "session_id": "…",
  "cost_usd": 0.31, "tokens": {"input": 18210, "output": 1420, "cache_read": 12000},
  "turns": 4,
  "outputs": {"hooks.md": {"bytes": 2210, "sha256": "…"}},
  "meta": {},
  "error": null
}
```

`status` ∈ `done`, `failed`, `blocked`, `interrupted`, `missing_output`,
`schema_invalid`, `timeout`. Costs are the engine's own estimate.

`flowy trace <node>` prints a readable version. The user's agent is expected
to read `result.json` and `trace.jsonl` to diagnose a node — that is how the
workflow gets fixed without the human re-explaining anything.

---

## 10. Layout: `layout.canvas`

Positions live in a [JSON Canvas](https://jsoncanvas.org) file and nowhere
else. Flowy uses it only for `id`, `x`, `y`, `width`, `height` of nodes and
the `fromNode`/`toNode` of edges; every node `id` must match a node id or a
foreach id, and edges must match `needs`. Anything else in the file is
preserved untouched. If the file is missing, `flowy layout` generates one
with a layered layout, and the viewer writes positions back when nodes are
dragged.

Semantic edits on the canvas (v3 roadmap) are performed by editing the
markdown/YAML files, then regenerating the manifest. The canvas file never
becomes an input to compilation.

Because it is JSON Canvas, Obsidian opens the layout read-only for free.

---

## 11. Compilation

`flowy compile` reads the workflow folder and writes the manifest (to
`.flowy/manifest.json` when run standalone, and to `runs/<run-id>/manifest.json`
at the start of each run):

- resolves every node file, validates frontmatter against this spec,
- resolves `needs` into edges, rejects cycles, unknown ids, and edges into
  foreach internals,
- checks that every `foreach` source names a node with a schema or a
  declared `*.json` output,
- checks `lock` names, `engine` names, `context` paths (must exist or be a
  template), `before` commands (must be non-empty strings),
- checks that gate nodes declare at least one `approve` field,
- emits a flat structure: `{nodes: {id: {…resolved…}}, edges: [...], foreach: {...}}`.

Errors are reported with file and line where possible and the compile fails.
This is the layer that catches an agent's authoring mistakes; the runner
trusts the manifest completely. The manifest is frozen per run: editing node
files while a run is in flight affects the next run, not this one
(`flowy run --run <id> --recompile` opts in).

---

## 12. CLI

```
flowy compile [dir]                       validate + write manifest, no run
flowy run [dir] [--input k=v]... [--until <node>] [--run <id>] [--recompile] [--dry]
flowy runs [dir]                          list runs, newest first
flowy status [dir] [--run <id>]           nodes, items, gates, costs
flowy approve <node> [--item <fe>/<id>] --set k=v ...
flowy rerun <node> [--item ...] [--feedback "..."]
flowy use <node> <version>
flowy chat <node> [--item ...]
flowy done <node> [--item ...]            mark a wait/chat node complete
flowy skip <foreach>/<item-id> [--undo]
flowy stop [dir]
flowy trace <node> [--version vN] [--raw]
flowy layout [dir]                        (re)generate layout.canvas
flowy serve [dir] [--port 3579]           local viewer
```

`<node>` addresses top-level nodes; `--item short/my-first-short` addresses a
node inside an item. Node commands take `--dir <workflow>` (default `.`).
All commands operate on the most recent run unless `--run` is given.
`flowy run --run <id>` resumes; add `--recompile` to pull edited workflow
files into that run.

---

## 13. Viewer

A local web server plus browser page. Read-mostly in v1:

- renders the graph from the manifest + `layout.canvas`; live-reloads on
  file changes (the human's agent edits files; the canvas updates),
- node cards show: status, mode, engine, current version, cost, duration,
  input size (bytes/tokens on each edge), stale/gate badges,
- foreach nodes expand into an item checklist,
- clicking a node shows outputs, versions side by side, `trace.jsonl`,
  `result.json`, and for gates the approval form generated from `approve:`,
- buttons map 1:1 to CLI commands (approve, rerun with feedback, use version,
  skip item, chat, run-until-here). The viewer never has abilities the CLI
  lacks.

The viewer binds to localhost only and has no authentication. It is a window
onto local files, not a service.

---

## 14. Security and trust

- Script nodes and `before:` commands execute arbitrary commands. Run only
  workflows you trust, the same way you would run a Makefile.
- Agent nodes run without permission prompts (`dontAsk`) inside a directory
  Flowy created. Their write access is that directory; their read access is
  that directory plus any `--add-dir` from §4.2. Tools beyond `Read`/`Write`
  must be listed explicitly under `tools:`.
- Flowy never talks to any network service itself. All model traffic is the
  engine's own.
- Nothing under `runs/` should be committed; it contains full prompts,
  traces, and outputs.

---

## 15. Compatibility promises (from v1)

- `flowy: 0` files will be readable by later runners with at most a
  migration warning.
- Trace envelopes and `result.json` keys are additive; existing keys keep
  their meaning.
- The run folder layout is stable within a major version so that tools
  (including the user's own agent) can rely on it.
