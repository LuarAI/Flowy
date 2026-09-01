import { promises as fs } from "node:fs";
import path from "node:path";
import { nowIso, readJsonOrNull, writeJson } from "../core/fsutil.js";
import type { TraceEvent } from "../core/types.js";
import { findOnPath, spawnProcess } from "./proc.js";
import { emptyResult, type Engine, type EngineJob, type EngineResult, type InteractiveJob } from "./types.js";

/**
 * OpenAI Codex CLI adapter: `codex exec --json`. Verified against codex-cli
 * 0.148 (Sept 2026). The JSONL event schema is not a stable contract, so
 * every event is kept as a raw trace payload and only a few fields are
 * relied upon: `thread.started.thread_id`, `turn.completed.usage`, and the
 * `item.*` kinds for trace typing.
 */
export class CodexEngine implements Engine {
  name = "codex";
  capabilities: Engine["capabilities"] = ["structured_output", "resume", "cost"];

  private async bin(config: Record<string, unknown>, env: NodeJS.ProcessEnv) {
    const b = typeof config.bin === "string" ? config.bin : await findOnPath("codex", env);
    if (!b) throw new Error("codex CLI not found on PATH (set engine.codex.bin)");
    return { cmd: b, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(b) };
  }

  async run(job: EngineJob): Promise<EngineResult> {
    const { cmd, shell } = await this.bin(job.config, job.env);
    const cfg = job.config;
    const lastFile = path.join(job.cwd, "out", "_last.md");
    const args = ["exec"];
    if (job.resumeSession) args.push("resume", job.resumeSession);
    args.push("--json", "--skip-git-repo-check", "-C", job.cwd, "--output-last-message", lastFile);
    args.push("--sandbox", typeof cfg.sandbox === "string" ? cfg.sandbox : "workspace-write");
    if (typeof cfg.model === "string" && cfg.model) args.push("--model", cfg.model);
    for (const d of job.addDirs) args.push("--add-dir", d);
    let schemaFile: string | null = null;
    if (job.schema) {
      schemaFile = path.join(job.cwd, "schema.json");
      await writeJson(schemaFile, job.schema);
      args.push("--output-schema", schemaFile);
    }
    if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args.map(String));
    args.push("-"); // prompt on stdin

    const res = emptyResult();
    const emit = (type: TraceEvent["type"], payload: unknown) => job.onEvent({ t: nowIso(), type, engine: this.name, payload });
    emit("start", { cmd, args });
    const outcome = await spawnProcess(cmd, args, {
      cwd: job.cwd,
      env: job.env,
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
        const item = (ev.item ?? null) as { type?: string; text?: string } | null;
        if (type === "thread.started" && typeof ev.thread_id === "string") {
          res.sessionId = ev.thread_id;
          emit("start", ev);
        } else if (type === "turn.completed") {
          const u = (ev.usage ?? {}) as Record<string, number>;
          res.tokens = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cached_input_tokens ?? 0 };
          emit("end", ev);
        } else if (type.startsWith("item.") && item) {
          const kind = item.type ?? "";
          if (kind === "reasoning") emit("thinking", ev);
          else if (kind === "agent_message") emit("text", { ...ev, text: item.text ?? "" });
          else if (/command|file_change|tool|mcp|web_search/.test(kind)) emit(type === "item.completed" ? "tool_result" : "tool_use", ev);
          else emit("text", ev);
        } else if (type === "error" || type === "turn.failed") {
          res.error = typeof ev.message === "string" ? ev.message : JSON.stringify(ev);
          emit("stderr", ev);
        } else emit("text", ev);
      },
    });
    res.exitCode = outcome.code;
    res.timedOut = outcome.timedOut;
    res.aborted = outcome.aborted;
    if (outcome.code !== 0 && !res.error) res.error = outcome.stderrTail || `exit ${outcome.code}`;

    if (schemaFile && outcome.code === 0) {
      // With --output-schema the final message is the JSON document.
      try {
        const text = await fs.readFile(lastFile, "utf8");
        res.structuredOutput = JSON.parse(text);
      } catch {
        const fallback = await readJsonOrNull(path.join(job.cwd, "out", "structured.json"));
        if (fallback !== null) res.structuredOutput = fallback;
      }
    }
    return res;
  }

  async interactive(job: InteractiveJob): Promise<number> {
    const { cmd, shell } = await this.bin(job.config, job.env);
    const args = ["-C", job.cwd];
    if (job.resumeSession) args.push("resume", job.resumeSession);
    args.push(`Read ${path.basename(job.promptFile)} in this directory and follow it. Inputs are in ./in, outputs go to ./out.`);
    return (await spawnProcess(cmd, args, { cwd: job.cwd, env: job.env, timeoutMs: 24 * 3600_000, shell, inherit: true })).code;
  }
}
