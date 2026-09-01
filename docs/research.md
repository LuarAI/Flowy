# Research digest (September 2026)

What exists, what doesn't, and what Flowy took from each. Five parallel
research passes: Claude Code orchestrators; local node/DAG tools and file
formats; AI video pipelines and editor automation; the Claude Code headless
substrate and its terms; and non-coding agent workflows. Condensed here with
sources. Dates matter — several of these facts changed within 2026.

## 1. The premise is validated, and the gap is real

- Anthropic shipped **Claude Cowork** (Jan 2026, expanded July 2026), a
  folder-scoped desktop agent, with the stated motivation: "we expected
  developers to use it for coding. They did — and then quickly began using
  it for almost everything else." Over 90% of Cowork usage is non-software
  work. Anthropic's own analysis of ~400k sessions shows writing and data
  analysis roughly doubled, and non-software professionals reach success
  rates within 7 points of engineers.
  - https://www.anthropic.com/research/claude-code-expertise
  - https://venturebeat.com/technology/anthropic-brings-claude-cowork-to-mobile-and-web-as-usage-data-shows-most-users-arent-coding
- Cowork is prompt-driven: it does not offer reusable pipelines, fan-out,
  versioned outputs, or approval gates. One writeup names the unmet need as
  work that is "repeatable, scoped, and reviewable — too small for a
  platform, too big for a chat."
- Loudest complaints from non-coders using Claude Code: the terminal barrier;
  repeatability requires "writing a parent slash command using intermediate
  files to pass data"; quota anxiety.
  - https://metacircuits.substack.com/p/claude-code-for-non-coders
  - https://www.maragu.dev/blog/claude-code-as-a-general-purpose-agent

**Market table.** Nobody occupies local + file-based + non-developer +
own-subscription:

| | Local | File-based | Non-dev | Own subscription |
|---|---|---|---|---|
| Claude Cowork | ✓ | ✓ | ✓ | ✓ (first-party) |
| Obsidian AI plugins | ✓ | ✓ | ✓ | ✗ API key |
| Gumloop / Lindy / Relevance | ✗ | ✗ | ✓ | ✗ credits |
| n8n / Windmill | ✓ | partly | ✗ | self-host |
| LangGraph / Temporal / Inngest | lib | ✗ | ✗ | — |

## 2. Terms of service — the constraint that shapes everything

Primary source: https://code.claude.com/docs/en/legal-and-compliance

- Prohibited: "developers may not collect, store, or intermediate Claude.ai
  credentials or session tokens." Anthropic does not permit "routing
  requests through Free, Pro, or Max plan credentials on behalf of users."
  Enforced server-side from March 2026; hard block on third-party agentic
  tools April 4, 2026 (OpenClaw was the visible casualty).
  - https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/
- Permitted, verbatim: "Nor does it prevent an end user from signing in to
  the **unmodified Claude Code binary** with their own Claude subscription."
  Conditions: binary not modified; no auth method disabled; no reselling or
  intermediating; each user authenticates themselves.
- Agent SDK docs, for any language other than TS/Python: "run the CLI as a
  subprocess with the `-p` flag and `--output-format json`."
  - https://code.claude.com/docs/en/agent-sdk/overview
- Branding: "Powered by Claude" allowed; "Claude Code" in a product name not.
- **Billing:** a May 14, 2026 announcement moved `claude -p` / Agent SDK
  usage to separate credits effective June 15; **paused that day**. Email:
  "Agent SDK, claude -p, and third-party app usage continues to work with
  your subscription exactly as it did before today." Status: temporary,
  advance notice promised.
  - https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
  - https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/
- **Rate limits:** advertised limits assume "ordinary, individual usage";
  community reports of throttling at 5–6 concurrent sessions on top tiers.
  - https://github.com/anthropics/claude-code/issues/62426

→ `DECISIONS.md` D1, D3, D6.

## 3. Claude Code as a substrate

Docs: https://code.claude.com/docs/en/headless ·
https://code.claude.com/docs/en/cli-reference ·
https://code.claude.com/docs/en/sessions

- `claude -p` with `--output-format stream-json --verbose` emits `system/init`
  (tools, capabilities), `assistant`/`user` messages with `thinking`,
  `tool_use`, `tool_result` blocks, `system/api_retry` with error categories
  (`rate_limit`, `authentication_failed`, `billing_error`), hook events, and
  a final `result` with `session_id`, `duration_ms`, `num_turns`,
  `total_cost_usd`, `usage`, `permission_denials`, `structured_output`.
  Subagents are tagged by `parent_tool_use_id`; `--forward-subagent-text`
  exposes their text.
- `--json-schema` gives validated structured output.
- `--permission-mode` defaults to Manual even for `-p`: must be set.
- `--bare` is "recommended for scripted/SDK calls and will become the default
  for `-p`" — and **never reads OAuth credentials**; it requires an API key.
  Bare and subscription auth are mutually exclusive.
- Without `--bare`, a `-p` run executes hooks from the cwd's
  `.claude/settings.json` and connects `.mcp.json` servers with no trust
  prompt. Flowy's version directories contain neither, and the adapter passes
  `--strict-mcp-config`.
- Exit 143 on SIGTERM, no result recorded; use SIGINT.
- `--resume <id>` works from any directory (v2.1.223+).
- Session transcripts at `~/.claude/projects/<slug>/<id>.jsonl`; the docs
  say the format "is internal to Claude Code and changes between versions."
  Flowy writes its own trace.
- Other engines have equivalents at the "headless in a dir, structured
  result" level: `codex exec --json --output-last-message`, `gemini -p
  --output-format stream-json`, `opencode run`, `copilot -p`. Event schemas
  differ and none is a stable contract.

→ `DECISIONS.md` D3, D5, D15; `SPEC.md` §8–9.

## 4. Orchestrators over Claude Code

Index: https://github.com/andyrewlee/awesome-agent-orchestrators (~177 tools).

- **Claude Code Dynamic Workflows** (research preview May 28, 2026; GA):
  Claude writes a JS script with `agent()`, `pipeline()`, `parallel()`,
  `phase()`; 16 concurrent agents, 4,096 items per pipeline, 1,000 agents
  per run; per-agent result caching with "re-run from the first agent whose
  prompt differs"; `/workflows` TUI with single-agent restart; determinism
  enforced by making `Date.now()`/`Math.random()` throw. Docs state: **"No
  mid-run user input — only agent permission prompts can pause a run. For
  sign-off between stages, run each stage as its own workflow."**
  - https://code.claude.com/docs/en/workflows
- **Shutdowns in H1 2026:** Vibe Kanban (28k★, April 10, "no viable business
  model"), Crystal (Feb, → closed Nimbalyst), Terragon (Feb, code dumped),
  HumanLayer (repo deprecated, closed product).
  - https://www.vibekanban.com/blog/shutdown
- Canvas over Claude Code runs is rare: **GraphCode** (macOS, nodes are live
  sessions; https://github.com/scgopi/GraphCode), **claude-workflow-composer**
  (React Flow canvas executing `claude -p`, not git-locked, with an Approval
  Gate node that resumes the same session;
  https://github.com/fayzan123/claude-workflow-composer), **agent-flow**
  (observation only, 1.6k★; https://github.com/patoles/agent-flow).
- The category is overwhelmingly locked to git worktrees/branches/PRs;
  general-purpose entrants (OpenWorker 17k★, Omnara) use API keys.
- No orchestrator documents its ToS position.

Ideas taken: resume semantics; determinism; prompt-cache stagger between
siblings; live-attachable sessions for `chat` mode; approval that resumes
the same session.

→ `DECISIONS.md` D4, D5, D9, D11.

## 5. Node/DAG tools and file formats

- **ComfyUI** cache (read from `comfy_execution/caching.py`): a recursive
  signature of node class + inputs + every ancestor's signature, node ids
  excluded. Two formats: the UI workflow JSON (with layout) and the flat
  API/prompt JSON sent to `POST /prompt` (no layout). Node expansion, lazy
  inputs, subgraphs. No native branching or human gate. Text/LLM use exists
  (official Anthropic partner nodes, `comfyui_LLM_party`).
  **ComfyBench (CVPR 2025): LLM agents resolve ~15% of creative
  workflow-authoring tasks** — hallucinated nodes, structural JSON errors.
- **Nodespell** (https://www.nodespell.com): real, cloud SaaS for AI
  filmmaking against hosted models; no file format, API, or self-hosting.
- Database-backed builders (n8n, Flowise, Langflow, Dify) keep workflows in a
  DB; files are export artifacts. n8n's Execute Command has `cwd` hardcoded
  to `process.cwd()` and is disabled by default in 2.0; Dify's sandbox cannot
  shell out. Windmill (AGPL) has the best approval UX and file-native
  scripts; Kestra has typed `onResume` inputs on `Pause`; Prefect has
  composable cache policies; Dagster Pipes streams metadata back from
  subprocesses; Nextflow verifies outputs exist before accepting a cache hit;
  Argo decides fan-out width at runtime; DVC separates run-cache from object
  cache.
- **Workflow-as-files precedents:** GitHub Agentic Workflows (markdown +
  frontmatter compiled to a lock file; https://github.github.io/gh-aw),
  Cannoli (DAG interpreter over Obsidian `.canvas`;
  https://github.com/DeabLabs/cannoli), Actionforge (graph file in git +
  visual editor + local runner), marimo (cell signature = edges), Nika
  (Rust, YAML DAG, "agent-written, human-reviewed", hash-chained receipts;
  https://github.com/supernovae-st/nika).
- **Open standard to adopt:** none with execution semantics. **JSON Canvas**
  (https://jsoncanvas.org, MIT) is the right container for layout only;
  Obsidian preserves unknown keys. Rejected: CWL (frozen), Open Workflow Spec
  (LLMs emit the old incompatible syntax), BPMN, GraphML/DOT.

→ `DECISIONS.md` D2, D5, D8; `SPEC.md` §6, §10, §11.

## 6. Video pipelines and editor automation

- Cloud clip tools with APIs: OpusClip, Vizard, Klap, Submagic. **Descript**
  exposes its agent ("Underlord") via `POST /jobs/agent` and an MCP
  connector — cloud only. Open source: **OpenShorts** (MIT, 3.8k★,
  faster-whisper + face tracking + captions + titles, built-in MCP server and
  REST API; https://github.com/mutonby/openshorts). MoneyPrinterTurbo and
  ShortGPT *generate* faceless videos; they don't repurpose recordings.
- **No video tool gates on creative approval mid-pipeline.** Human-in-the-loop
  in agent frameworks is applied to risky actions (publish, pay), not
  creative checkpoints.
- **No "ComfyUI for video editing"** exists; ComfyUI's video nodes are
  generation. The interchange standard for cut decisions is
  **OpenTimelineIO** (Academy Software Foundation, Apache 2.0;
  https://github.com/AcademySoftwareFoundation/OpenTimelineIO).
- **CapCut/JianYing:** mature draft-generation ecosystem — pyJianYingDraft
  (4.3k★), pyCapCut, CapCutAPI/VectCutAPI (2.2k★, HTTP + MCP), capcut-cli
  (MIT, JSON in/out, `cut` for long-form → shorts), several MCP servers.
  **Encryption:** JianYing 6.0+/7+ encrypts `draft_content.json` on save;
  round-trip editing impossible there; CapCut 6.x–9.x still plain JSON;
  export UI automation only ≤6.8. Generation-only survives; pin the version.
  - https://github.com/GuanYixuan/pyJianYingDraft ·
    https://github.com/renezander030/capcut-cli ·
    https://gist.github.com/renezander030/80823f1d47081c312d2c1f9edd20dc22
- **Kinocut** (Apache 2.0, v1.15, Aug 2026): 196 MCP tools over FFmpeg with
  preflight validation, checksummed "receipts", a repurposing pipeline, and a
  multi-step workflow engine with resume. https://github.com/KyaniteLabs/mcp-video
- YouTube MCP servers exist for SEO/upload with the user's own OAuth
  (https://github.com/pauling-ai/youtube-mcp-server).

→ `DECISIONS.md` D7; `examples/shorts-pipeline`.

## 7. Context files and human-in-the-loop patterns

- **AGENTS.md** is read natively by Claude Code, Codex, Cursor, Aider, Gemini
  CLI, Copilot, Windsurf, Amazon Q. Plugin folders (`plugin.json` + skills /
  agents / hooks) are the packaging unit; a marketplace can be a local folder.
- Research found **LLM-generated context files reduced success rates and
  raised cost >20%**; human-written ones helped only when minimal.
  - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Durable pause: Temporal (signals + timers, zero cost while waiting),
  Inngest (`step.waitForEvent`), LangGraph (`interrupt_before` +
  checkpointer), Windmill (suspend/resume with secret resume URLs),
  HumanLayer. Common pattern: externalise state, hold no process, resume from
  a token. Locally: a file.

→ `DECISIONS.md` D4, D10; `AGENTS.md`.
