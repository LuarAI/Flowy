import path from "node:path";
import { nowIso } from "../core/fsutil.js";
import type { TraceEvent } from "../core/types.js";
import { findOnPath, spawnProcess } from "./proc.js";
import { emptyResult, type Engine, type EngineJob, type EngineResult, type InteractiveJob } from "./types.js";

/** Gemini CLI adapter: `gemini -p --output-format stream-json`. Best effort. */
export class GeminiEngine implements Engine {
  name = "gemini";
  capabilities = ["cost"] as Engine["capabilities"];

  private async bin(config: Record<string, unknown>, env: NodeJS.ProcessEnv) {
    const b = typeof config.bin === "string" ? config.bin : await findOnPath("gemini", env);
    if (!b) throw new Error("gemini CLI not found on PATH (set engine.gemini.bin)");
    return { cmd: b, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(b) };
  }

  async run(job: EngineJob): Promise<EngineResult> {
    const { cmd, shell } = await this.bin(job.config, job.env);
    const cfg = job.config;
    // The prompt is already in ./prompt.md; point the CLI at it to avoid shell quoting.
    const args = ["-p", "Read prompt.md in the current directory and follow it exactly. Inputs are in ./in, outputs go to ./out.", "--output-format", "stream-json", "--yolo"];
    if (typeof cfg.model === "string" && cfg.model) args.push("--model", cfg.model);
    for (const d of job.addDirs) args.push("--include-directories", d);
    if (Array.isArray(cfg.extra_args)) args.push(...cfg.extra_args.map(String));

    const res = emptyResult();
    const emit = (type: TraceEvent["type"], payload: unknown) => job.onEvent({ t: nowIso(), type, engine: this.name, payload });
    emit("start", { cmd, args });
    const outcome = await spawnProcess(cmd, args, {
      cwd: job.cwd,
      env: job.env,
      stdin: null,
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
        if (type === "tool_call" || type === "tool_use") emit("tool_use", ev);
        else if (type === "tool_result") emit("tool_result", ev);
        else if (ev.stats && typeof ev.stats === "object") {
          const s = ev.stats as Record<string, unknown>;
          const m = (s.models ?? {}) as Record<string, { tokens?: Record<string, number> }>;
          let input = 0;
          let output = 0;
          let cached = 0;
          for (const v of Object.values(m)) {
            input += v.tokens?.prompt ?? v.tokens?.input ?? 0;
            output += v.tokens?.candidates ?? v.tokens?.output ?? 0;
            cached += v.tokens?.cached ?? 0;
          }
          res.tokens = { input, output, cache_read: cached };
          emit("end", ev);
        } else emit("text", ev);
      },
    });
    res.exitCode = outcome.code;
    res.timedOut = outcome.timedOut;
    res.aborted = outcome.aborted;
    if (outcome.code !== 0) res.error = outcome.stderrTail || `exit ${outcome.code}`;
    return res;
  }

  async interactive(job: InteractiveJob): Promise<number> {
    const { cmd, shell } = await this.bin(job.config, job.env);
    const args = ["-i", `Read ${path.basename(job.promptFile)} in this directory and follow it. Inputs are in ./in, outputs go to ./out.`];
    return (await spawnProcess(cmd, args, { cwd: job.cwd, env: job.env, timeoutMs: 24 * 3600_000, shell, inherit: true })).code;
  }
}
