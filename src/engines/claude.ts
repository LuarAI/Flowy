import { promises as fs } from "node:fs";
import path from "node:path";
import { nowIso } from "../core/fsutil.js";
import type { TraceEvent } from "../core/types.js";
import { findOnPath, spawnProcess } from "./proc.js";
import { emptyResult, type Engine, type EngineJob, type EngineResult, type InteractiveJob } from "./types.js";

/**
 * Claude Code adapter (SPEC §8.1).
 *
 * Rules that must never be relaxed (DECISIONS D1):
 *  - spawns the user's own installed `claude`; never a bundled or patched copy
 *  - never reads, injects, or strips credentials; the environment is passed through
 *  - always sets --permission-mode explicitly
 *  - never uses --bare (it disables subscription auth)
 */
export class ClaudeEngine implements Engine {
  name = "claude";
  capabilities: Engine["capabilities"] = ["structured_output", "resume", "thinking", "subagent_trace", "cost"];

  private resolved: { cmd: string; args: string[]; shell: boolean } | null = null;

  /**
   * Locate the CLI. On Windows the npm shim is a .cmd, which Node can only
   * spawn through a shell — and shell quoting would mangle JSON arguments —
   * so we prefer running the package's cli.js with the current Node binary.
   */
  private async resolveBinary(config: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{ cmd: string; args: string[]; shell: boolean }> {
    if (this.resolved) return this.resolved;
    const bin = typeof config.bin === "string" ? config.bin : null;
    const found = bin ?? (await findOnPath("claude", env));
    if (!found) throw new Error("claude CLI not found on PATH (set engine.claude.bin in workflow.yaml)");
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
      const cliJs = path.join(path.dirname(found), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
      try {
        await fs.access(cliJs);
        this.resolved = { cmd: process.execPath, args: [cliJs], shell: false };
        return this.resolved;
      } catch {
        this.resolved = { cmd: found, args: [], shell: true };
        return this.resolved;
      }
    }
    this.resolved = { cmd: found, args: [], shell: false };
    return this.resolved;
  }

  /**
   * Variables that mark "this process is a Claude Code session". A headless
   * child must not look like a nested interactive session or attach to the
   * parent's messaging socket, so these are removed. Nothing here is a
   * credential; CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY are untouched.
   */
  static readonly SESSION_VARS = [
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
  ];

  private childEnv(env: NodeJS.ProcessEnv, config: Record<string, unknown>): NodeJS.ProcessEnv {
    const out = { ...env };
    if (config.inherit_session !== true) for (const k of ClaudeEngine.SESSION_VARS) delete out[k];
    return out;
  }

  private permFiles: { script: string; config: string } | null = null;

  /** Write the permission-prompt MCP server + its config into the temp dir (once per process). */
  private async ensurePermFiles(): Promise<{ promptFiles: { script: string; config: string } }> {
    if (this.permFiles) return { promptFiles: this.permFiles };
    const os = await import("node:os");
    const { PERM_SCRIPT_SOURCE } = await import("./permscript.js");
    const dir = path.join(os.tmpdir(), "flowy-perm");
    await fs.mkdir(dir, { recursive: true });
    const script = path.join(dir, "perm-mcp.mjs");
    await fs.writeFile(script, PERM_SCRIPT_SOURCE, "utf8");
    const config = path.join(dir, "perm-mcp-config.json");
    await fs.writeFile(config, JSON.stringify({ mcpServers: { "flowy-perm": { command: process.execPath, args: [script] } } }), "utf8");
    this.permFiles = { script, config };
    return { promptFiles: this.permFiles };
  }

  async run(job: EngineJob): Promise<EngineResult> {
    const { cmd, args: pre, shell } = await this.resolveBinary(job.config, job.env);
    const cfg = job.config;
    const env = this.childEnv(job.env, cfg);
    const args = [
      ...pre,
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      // with a permission prompt wired up, unlisted tools ask instead of being denied
      job.permissionPrompt ? "default" : typeof cfg.permission_mode === "string" ? cfg.permission_mode : "dontAsk",
      "--strict-mcp-config",
    ];
    if (job.permissionPrompt && !shell) {
      const { promptFiles } = await this.ensurePermFiles();
      args.push("--mcp-config", promptFiles.config, "--permission-prompt-tool", "mcp__flowy-perm__approve");
      env.FLOWY_PERM_URL = job.permissionPrompt.url;
      env.FLOWY_PERM_TOKEN = job.permissionPrompt.token;
    }
    if (cfg.partial === true) args.push("--include-partial-messages");
    if (job.tools.length) args.push("--allowedTools", job.tools.join(","));
    if (job.schema && !shell) args.push("--json-schema", JSON.stringify(job.schema));
    if (job.resumeSession) {
      args.push("--resume", job.resumeSession);
      if (job.forkSession) args.push("--fork-session");
    }
    for (const d of job.addDirs) args.push("--add-dir", d);
    if (typeof cfg.model === "string" && cfg.model) args.push("--model", cfg.model);
    if (typeof cfg.effort === "string" && cfg.effort) args.push("--effort", cfg.effort);
    if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args.map(String));

    const res = emptyResult();
    const emit = (type: TraceEvent["type"], payload: unknown) => job.onEvent({ t: nowIso(), type, engine: this.name, payload });
    emit("start", { cmd, args: args.filter((a) => a !== JSON.stringify(job.schema)) });

    let lastError: string | null = null;
    const outcome = await spawnProcess(cmd, args, {
      cwd: job.cwd,
      env,
      stdin: job.prompt,
      timeoutMs: job.timeoutMs,
      signal: job.signal,
      shell,
      onStderrLine: (l) => emit("stderr", l),
      onStdoutLine: (line) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line);
        } catch {
          emit("stdout", line);
          return;
        }
        const type = String(ev.type ?? "");
        if (type === "system") {
          const sub = String(ev.subtype ?? "");
          if (sub === "init") {
            if (typeof ev.session_id === "string") res.sessionId = ev.session_id;
            emit("start", ev);
          } else if (sub === "api_retry") emit("retry", ev);
          else emit("text", ev);
        } else if (type === "assistant" || type === "user") {
          const msg = ev.message as { content?: unknown } | undefined;
          const blocks = Array.isArray(msg?.content) ? (msg!.content as Array<Record<string, unknown>>) : [];
          const sub = ev.parent_tool_use_id ? "subagent" : null;
          for (const b of blocks) {
            const bt = String(b.type ?? "");
            const kind: TraceEvent["type"] =
              bt === "thinking" ? "thinking" : bt === "tool_use" ? "tool_use" : bt === "tool_result" ? "tool_result" : "text";
            emit(sub && kind === "text" ? "subagent" : kind, { ...b, parent_tool_use_id: ev.parent_tool_use_id ?? null });
          }
          if (!blocks.length) emit("text", ev);
        } else if (type === "result") {
          if (typeof ev.session_id === "string") res.sessionId = ev.session_id;
          if (typeof ev.result === "string") res.text = ev.result;
          if (typeof ev.total_cost_usd === "number") res.costUsd = ev.total_cost_usd;
          if (typeof ev.num_turns === "number") res.turns = ev.num_turns;
          const u = ev.usage as Record<string, number> | undefined;
          if (u) res.tokens = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0 };
          if ("structured_output" in ev) res.structuredOutput = ev.structured_output;
          if (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success")) {
            lastError = typeof ev.result === "string" ? ev.result : String(ev.subtype ?? "error");
          }
          emit("end", ev);
        } else if (type === "stream_event") {
          if (cfg.partial === true) emit("text", ev);
        } else {
          emit("text", ev);
        }
      },
    });

    res.exitCode = outcome.code;
    res.timedOut = outcome.timedOut;
    res.aborted = outcome.aborted;
    if (outcome.code !== 0 && !res.error) res.error = lastError ?? outcome.stderrTail ?? `exit ${outcome.code}`;
    else if (lastError) res.error = lastError;
    return res;
  }

  async interactive(job: InteractiveJob): Promise<number> {
    const { cmd, args: pre } = await this.resolveBinary(job.config, job.env);
    // For the interactive session we can afford the shell on Windows (no JSON args).
    const useShell = process.platform === "win32" && !pre.length;
    const args = [...pre];
    if (job.resumeSession) args.push("--resume", job.resumeSession);
    else if (job.sessionId) args.push("--session-id", job.sessionId);
    for (const d of job.addDirs) args.push("--add-dir", d);
    if (typeof job.config.model === "string" && job.config.model) args.push("--model", job.config.model);
    args.push(`Read ${path.basename(job.promptFile)} in this directory and follow it. Inputs are in ./in, outputs go to ./out.`);
    const outcome = await spawnProcess(cmd, args, {
      cwd: job.cwd,
      env: this.childEnv(job.env, job.config),
      timeoutMs: 24 * 3600_000,
      shell: useShell,
      inherit: true,
    });
    return outcome.code;
  }
}
