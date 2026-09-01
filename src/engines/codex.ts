import path from "node:path";
import { nowIso } from "../core/fsutil.js";
import type { TraceEvent } from "../core/types.js";
import { findOnPath, spawnProcess } from "./proc.js";
import { emptyResult, type Engine, type EngineJob, type EngineResult, type InteractiveJob } from "./types.js";

/**
 * OpenAI Codex CLI adapter: `codex exec --json`. Best effort — the event
 * schema is not a stable contract (docs/research.md §3), so everything is
 * passed through as trace payloads and only the exit code and last message
 * are relied upon.
 */
export class CodexEngine implements Engine {
  name = "codex";
  capabilities = ["resume", "cost"] as Engine["capabilities"];

  private async bin(config: Record<string, unknown>, env: NodeJS.ProcessEnv) {
    const b = typeof config.bin === "string" ? config.bin : await findOnPath("codex", env);
    if (!b) throw new Error("codex CLI not found on PATH (set engine.codex.bin)");
    return { cmd: b, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(b) };
  }

  async run(job: EngineJob): Promise<EngineResult> {
    const { cmd, shell } = await this.bin(job.config, job.env);
    const cfg = job.config;
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", job.cwd, "--output-last-message", path.join(job.cwd, "out", "_last.md")];
    if (typeof cfg.sandbox === "string") args.push("--sandbox", cfg.sandbox);
    else args.push("--sandbox", "workspace-write");
    if (typeof cfg.model === "string" && cfg.model) args.push("--model", cfg.model);
    if (job.resumeSession) args.push("resume", job.resumeSession);
    if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args.map(String));
    // Prompt via stdin. `-` tells codex to read the prompt from stdin.
    args.push("-");

    let prompt = job.prompt;
    if (job.schema) {
      prompt += `\n\n## Structured output\nWrite a JSON document matching this schema to out/structured.json:\n\n${JSON.stringify(job.schema, null, 2)}\n`;
    }
    const res = emptyResult();
    const emit = (type: TraceEvent["type"], payload: unknown) => job.onEvent({ t: nowIso(), type, engine: this.name, payload });
    emit("start", { cmd, args });
    const outcome = await spawnProcess(cmd, args, {
      cwd: job.cwd,
      env: job.env,
      stdin: prompt,
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
        const type = String(ev.type ?? ev.msg ?? "");
        if (/thread|session/.test(type) && typeof ev.thread_id === "string") res.sessionId = ev.thread_id;
        if (/command|tool|exec|patch/.test(type)) emit(/result|output|end|completed/.test(type) ? "tool_result" : "tool_use", ev);
        else if (/reasoning/.test(type)) emit("thinking", ev);
        else if (/usage|token/.test(type) || ev.usage) {
          const u = (ev.usage ?? ev) as Record<string, number>;
          res.tokens = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cache_read: u.cached_input_tokens ?? 0 };
          emit("text", ev);
        } else emit("text", ev);
      },
    });
    res.exitCode = outcome.code;
    res.timedOut = outcome.timedOut;
    res.aborted = outcome.aborted;
    if (outcome.code !== 0) res.error = outcome.stderrTail || `exit ${outcome.code}`;
    emit("end", { exit: outcome.code });
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
