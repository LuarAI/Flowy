import path from "node:path";
import { nowIso } from "../core/fsutil.js";
import type { TraceEvent } from "../core/types.js";
import { platformShell, spawnProcess } from "./proc.js";
import { emptyResult, type Engine, type EngineJob, type EngineResult } from "./types.js";

/**
 * Generic engine: `engine.custom.command` is a shell command with the
 * placeholders {prompt_file} and {cwd}. No capabilities; the result is the
 * exit code plus whatever files appear in out/.
 */
export class CustomEngine implements Engine {
  name = "custom";
  capabilities = [] as Engine["capabilities"];

  async run(job: EngineJob): Promise<EngineResult> {
    const template = typeof job.config.command === "string" ? job.config.command : null;
    if (!template) throw new Error("engine.custom.command is required in workflow.yaml");
    const promptFile = path.join(job.cwd, "prompt.md");
    const command = template.replaceAll("{prompt_file}", promptFile).replaceAll("{cwd}", job.cwd);
    const sh = platformShell();
    const res = emptyResult();
    const emit = (type: TraceEvent["type"], payload: unknown) => job.onEvent({ t: nowIso(), type, engine: this.name, payload });
    emit("start", { command });
    const outcome = await spawnProcess(sh.cmd, [...sh.args, command], {
      cwd: job.cwd,
      env: job.env,
      timeoutMs: job.timeoutMs,
      signal: job.signal,
      onStdoutLine: (l) => emit("stdout", l),
      onStderrLine: (l) => emit("stderr", l),
    });
    res.exitCode = outcome.code;
    res.timedOut = outcome.timedOut;
    res.aborted = outcome.aborted;
    if (outcome.code !== 0) res.error = outcome.stderrTail || `exit ${outcome.code}`;
    emit("end", { exit: outcome.code });
    return res;
  }
}
