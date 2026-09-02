# Writing Flowy workflows — a guide for agents

You are an AI agent (Claude Code, Codex, Gemini CLI, …) and a human has asked
you to create, edit, or debug a Flowy workflow. This file tells you how. The
full contract is in `SPEC.md`; this is the working summary.

## What a workflow is

A folder:

```
my-workflow/
  workflow.yaml     # inputs, engine, concurrency, locks, node list
  nodes/<id>.md     # one node per file: YAML frontmatter + prompt body
  context/          # guideline files nodes may read
  scripts/          # commands used by script nodes
  layout.canvas     # positions only; you may ignore it
  runs/             # produced by Flowy; read it to debug, never edit it
```

Nodes form a DAG through `needs:`. Each node runs in its own directory with
`in/` (what it may read) and `out/` (what it must produce). Agent nodes see
**only** `in/`, their prompt, and their allowed tools. Nothing else.

## The one idea to hold on to

**Files in → prompt → files out.** A node does not "know" anything the
previous conversation knew. Whatever it needs must arrive as a file under
`in/` — either from an upstream node's `out/`, from `context:`, or from
`in/_inputs.json`. If you find yourself writing "as discussed earlier" in a
prompt, the workflow is wrong.

## Authoring checklist

1. **Start from the human's existing process description.** Most people
   already have a doc, a checklist, or a habit. Turn each step into a node.
   Do not add steps they did not describe.
2. **Pick a mode per node:**
   - `agent` — a headless LLM run. The body is the prompt.
   - `script` — a command (`run:`). Whisper, ffmpeg, pandoc, a Python file.
   - `wait` — the human does something and drops a file in `out/`.
   - `chat` — an interactive session for steps that are conversations.
   Prefer `agent` + `approve:` over `chat` for reviews. When the human
   cannot spell out the step in advance, make it `chat` with a short
   intent body: the first run is the demonstration, and the conversation
   crystallizes into the recipe automatically (`recipe: true` appears and
   the body becomes the learned instruction — never hand-write
   `recipe: true` yourself). `continues: <node>` makes a node a branch of
   another's session — use it for "keep working in the same conversation",
   not instead of `needs` file-passing.
3. **Declare `outputs:` exactly.** The runner verifies them. An agent node
   that "answers in chat" and writes nothing fails. Tell the prompt to write
   `out/<file>` explicitly.
4. **Give each agent node the smallest `context:` that works.** Context cost
   shows on every edge in the viewer; bloat is visible and embarrassing. Do
   not attach a whole folder when one file is enough. Do not generate
   guideline files yourself — ask the human for theirs.
5. **Put gates where the human said they decide.** "I pick the hook" →
   `approve: { chosen: {type: integer} }` on the hooks node. Approval fields
   are *data the next node reads* (`in/hooks/approval.yaml`); name them as
   such.
6. **Use `schema:` for anything a `foreach` will iterate over.** A structured
   output is validated; a prose list is not.
7. **Fan out with `foreach`** when one step produces many independent
   things (ideas, posts, clips). Put the per-item steps in a nested workflow
   folder. Keep per-item `concurrency` small (2–3). Inside the item, read
   the item's own data from `in/_inputs.json` (`item`) or `{{item.<field>}}`;
   only add the source node to `needs:` if the item genuinely needs the
   *whole* list — because then every item is invalidated whenever the list
   changes (the cache hashes inputs by content).
8. **Declare locks** for exclusive resources: a GPU, an editor that must be
   closed while a project file is written, a browser profile.
9. **Reference tools by their scripts.** Flowy ships no domain tools. A
   script node calls whatever the human already uses. Document what each
   script must read (`FLOWY_IN`) and write (`FLOWY_OUT`) in `scripts/README.md`.
10. **Never derive time or randomness inside a node.** Use `{{run.started}}`
    and `{{run.seed}}`.
11. **Match the model to the step.** `model:`/`effort:` on a node override
    the workflow default: heavy writing on high effort, mechanical assembly
    on a small model (`model: haiku`). Changing them re-runs the node (they
    are part of the cache signature).
11. **Run `flowy compile` before declaring the workflow done.** It reports
    unknown ids, cycles, missing outputs, bad locks, and gate nodes without
    `approve` fields, with file and line.

## Prompt-writing rules for `agent` nodes

- First line: what the node is for, in one sentence.
- Then: which files under `in/` to read and what each one is.
- Then: what to write under `out/`, with the exact filename(s) and format.
- Use `{{inputs.<name>}}` and `{{item.<field>}}` for run parameters; nothing
  else is templated.
- Do not restate the guideline files' content — point to them under `in/context/`.
- If the node is a gate, end with what the human will decide, so the output
  is shaped for that decision (numbered options, one per line, short).

Example:

```markdown
---
id: titles
mode: agent
needs: [transcribe-vo, body]
context: [context/titles-guide.md]
outputs: [titles.md]
approve:
  chosen: { type: integer, required: true }
  notes: { type: string }
---

Write title and description options for a vertical short.

Read `in/transcribe-vo/full.txt` (what is said in the final voice-over) and
`in/body/approval.yaml` + `in/body/script.md` (the approved angle). Follow
`in/context/titles-guide.md` exactly.

Write `out/titles.md` with five numbered options. Each option: a title line
(≤ 40 characters, keyword first), then a description (≤ 3 lines), then the
hashtag line. Language: {{inputs.language}}.
```

## Debugging a run

Everything is under `runs/<run-id>/`. For a top-level node:
`nodes/<id>/<version>/`; for an item: `items/<foreach>/<item-id>/nodes/<id>/<version>/`.
The `current` file names the version that feeds downstream.

Read, in this order:

1. `result.json` — status, error, cost, duration, which outputs were verified.
2. `prompt.md` — the exact prompt that ran, templates resolved. If it is not
   what you intended, fix the node file, not the run.
3. `in/` — what the node actually saw. Missing or stale files here mean a
   `needs:`/`context:` problem.
4. `trace.jsonl` — every engine event. `type: thinking` shows reasoning,
   `tool_use`/`tool_result` show file reads and writes, `retry` shows rate
   limits or auth errors.
5. `stderr.log` for script nodes.

Common failures:

| `result.json` status | Usual cause | Fix |
|---|---|---|
| `missing_output` | prompt did not say to write the file, or wrote elsewhere | name `out/<file>` in the prompt |
| `schema_invalid` | prose where JSON was required | tighten the prompt; show the shape |
| `blocked` | a `before:` check failed (editor open, disk full) | read the message; fix the environment |
| `timeout` | node too large or a tool hung | split the node; raise `timeout` |
| `failed` with `retry` events | rate limit / auth | lower `concurrency`; check the engine login |
| node is `stale` | a context file or upstream output changed | expected; `flowy run` re-runs it |

To fix a node, edit `nodes/<id>.md`, then `flowy rerun <id>` (add
`--feedback "..."` to carry the human's note into the new version). Do not
edit files under `runs/` — except `approval.yaml` and outputs at a gate,
which is how the human approves or curates.

## Things you must not do

- Do not read, copy, or print the user's credentials or tokens, for any
  engine. Flowy does not; neither do you.
- Do not put absolute personal paths into node files that will be shared.
  Use `inputs:` of type `path`.
- Do not write semantics into `layout.canvas`. It only holds positions.
- Do not invent fields. Unknown frontmatter keys fail compilation; the field
  list is in `SPEC.md` §1.2.
