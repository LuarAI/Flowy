# Roadmap

## v0 — Specification ✔

`SPEC.md`, `DECISIONS.md`, `AGENTS.md`, `docs/research.md`, and three
example workflows. The spec was written before any code; every construct the
implementation needed that the spec lacked was added to the spec first
(nested `needs` to top-level nodes, `{{workflow.scripts}}`, context layout
rules, large-file signatures).

## v1 — Runner + read-mostly viewer ✔

- `flowy compile`: validation with file:line issues (SPEC §11).
- `flowy run`: `agent` and `script` modes, gates, `foreach` with runtime
  width and orphan detection, versions, recursive signatures with
  verify-on-resume, global and per-foreach concurrency, sibling stagger,
  run lock, SIGINT cancellation.
- Claude adapter with stream-json traces, structured output via
  `--json-schema`, session resume on feedback reruns, nested-session
  handling.
- `status`, `approve`, `rerun --feedback`, `use`, `skip`, `done`, `trace`,
  `runs`, `stop`, `layout`.
- Viewer: React Flow canvas from `layout.canvas`, live reload over a
  websocket, node cards with status/version/cost, edge sizes, foreach item
  checklist, node panel (outputs, prompt, trace, versions with side-by-side
  compare, inputs), approval form, rerun with feedback, chat command, new
  run with inputs, run/continue/stop, log drawer.
- 18 tests over compile, run, gates, foreach, wait, locks, `--until`,
  pre-checks — all with the deterministic `mock` engine.

## v2 — The interactive parts (mostly ✔)

- `wait` mode ✔ (polls each scheduler tick; the viewer/watcher re-triggers).
- `chat` mode ✔: `flowy chat <node>` opens the engine interactively in the
  version directory, resuming the session of a gated agent node.
- Locks and `before:` pre-checks ✔.
- Large-file references (`_refs.json`, `--add-dir`) ✔ (untested with real
  multi-GB media).
- Codex adapter ✔ verified against codex-cli 0.148 (agent node, structured
  output via `--output-schema`, token usage, trace typing of
  `file_change`/`command_execution`/`reasoning` items). Gemini adapter:
  written, **untested**.
- OpenTimelineIO in `shorts-pipeline`: the edit plan is a portable JSON; the
  `.otio` file is produced by the user's `build_draft` script (contract in
  `examples/shorts-pipeline/scripts/README.md`). No OTIO library in Flowy.
- **Open:** the shorts pipeline has not been run end to end — its scripts
  are the user's own and are described, not shipped.

## v3 — Editing on the canvas (partial ✔)

- Add/remove edges by dragging between handles / Delete key; add and delete
  nodes; edit a node's prompt body — all written back to `workflow.yaml` and
  `nodes/*.md` with targeted text edits, validated by recompiling ✔.
- **Open:** workflow-level snapshots/diffs; a node library (reuse a node
  file across workflows by reference); editing structural frontmatter
  (mode, outputs, approve) from the viewer.

## Recipes and branches (added 2026-09-02) ✔

Demonstrate → crystallize → replay (DECISIONS D16): chat nodes distill
their finished conversation into the node body (`recipe: true`), then run
headless; feedback reruns and re-opened chats re-distill; `continues:`
forks the parent node's session for branch memory. `flowy recipe`,
auto-crystallize after `flowy chat`, viewer button on chat papers.

**Open:** branch feedback flowing back into the *parent's* recipe;
a canvas gesture for "repeat this chain for each item of a list"
(today: wrap it as a foreach sub-workflow by hand or via your agent).

## The canvas IS Excalidraw (2026-09-02) ✔

The viewer embeds the real Excalidraw editor (`@excalidraw/excalidraw`,
MIT). Flowy draws the workflow as ordinary elements (`fl-*` ids) and maps
native gestures onto the files: draw a rectangle → a small form makes it a
step; draw an arrow card→card → a `needs:` edge; arrow pill→card → attaches
that context file; Delete → removes the node/edge/context (nodes confirm);
drag → positions persist. Anything else drawn or written is the user's
sketch, saved to `sketch.excalidraw.json` beside the workflow. A selected
card shows an "open →" chip that opens its paper.

**Open:** foreach blocks can't be created/deleted from the canvas yet;
undo of a canvas-mapped action doesn't undo the file edit (redraw instead).

## Viewer backlog (agreed 2026-09, not yet built)

The format stays as is; these are view-layer changes:

1. **Tokens first, dollars second.** On subscription plans the cost figure
   is an API-equivalent estimate, not money spent; show tokens prominently
   and the estimate as "≈$ API-equiv" (workflow setting `billing:`).
2. **Context pills on the canvas** — render each `context:` entry and run
   input as a small source node with edges into the steps that read it;
   click for size/mtime/who-uses-it; delete edge = remove entry.
3. **Output chips on cards** and a Results tray collecting the outputs of
   terminal nodes.
4. **Simplified `+ step` dialog**: name + "what happens here" + three
   choices (Claude does it / we do it together / I do it myself); `script`
   under an advanced toggle. Model dropdown.
5. **Drag & drop a file** onto the canvas/node → copy into `context/` and
   add the entry. Browsers do not expose absolute paths, so **folders** get
   a Browse… button instead: the local server opens the native OS folder
   picker and returns the real path.
6. **Chat/trace collapse** — long transcripts and traces collapsed by
   default with a summary line.
7. **Checklist language** — present a foreach as a checklist; "+ add item"
   writes an item by hand into the same pipeline.

## Known gaps and next steps

1. Run `examples/video-to-blog` end to end with real scripts (needs the
   user's transcript fetcher).
2. Test the Gemini adapter against a real `gemini` install; test
   `codex exec resume` ordering for feedback reruns.
3. `flowy stop` on Windows kills the scheduler outright (no SIGINT
   semantics); running engines are orphaned. Use Ctrl+C in the terminal that
   runs `flowy run`, or the viewer's stop button, which aborts in-process.
4. The viewer has no file upload for `wait` nodes — drop files in `out/`
   (the path is shown).
5. No per-edge token counts yet — edges show upstream output bytes.
6. Nested `foreach` inside a nested workflow is not supported.

## Not planned

Hosted service, embedded chat, auto-generated context, Electron, editor
round-trips. See `DECISIONS.md` D10.
