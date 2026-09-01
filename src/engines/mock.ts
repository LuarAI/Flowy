import path from "node:path";
import { listFiles, nowIso, writeText } from "../core/fsutil.js";
import { emptyResult, type Engine, type EngineJob, type EngineResult } from "./types.js";

/**
 * A deterministic engine for tests and dry runs. It reads directives from the
 * prompt so a test workflow can script exactly what "the agent" does:
 *
 *   MOCK_WRITE <file> <<< <text>     write out/<file> with <text>
 *   MOCK_JSON <<< <json>             return <json> as the structured output
 *   MOCK_FAIL [message]              exit 1
 *   MOCK_SLEEP <ms>                  wait (to exercise concurrency/locks)
 *   MOCK_NO_DEFAULTS                 do not write undeclared default outputs
 *   MOCK_LIST_IN                     write out/_in.txt with a listing of in/
 *
 * Every declared output that was not written explicitly is written with the
 * prompt as its content, so any node "succeeds" by default.
 */
export class MockEngine implements Engine {
  name = "mock";
  capabilities = ["structured_output", "resume", "cost"] as Engine["capabilities"];
  private counter = 0;

  async run(job: EngineJob): Promise<EngineResult> {
    const res = emptyResult();
    const emit = (type: Parameters<EngineJob["onEvent"]>[0]["type"], payload: unknown) =>
      job.onEvent({ t: nowIso(), type, engine: this.name, payload });
    emit("start", { resume: job.resumeSession, tools: job.tools, addDirs: job.addDirs });

    const written = new Set<string>();
    let fail: string | null = null;
    let noDefaults = false;
    for (const raw of job.prompt.split("\n")) {
      const line = raw.trim();
      let m: RegExpExecArray | null;
      if ((m = /^MOCK_WRITE\s+(\S+)\s+<<<\s?(.*)$/.exec(line))) {
        await writeText(path.join(job.cwd, "out", m[1]), m[2] + "\n");
        written.add(m[1]);
        emit("tool_use", { name: "Write", input: { file_path: `out/${m[1]}` } });
      } else if ((m = /^MOCK_JSON\s+<<<\s?(.*)$/.exec(line))) {
        res.structuredOutput = JSON.parse(m[1]);
      } else if ((m = /^MOCK_FAIL\s*(.*)$/.exec(line))) {
        fail = m[1] || "mock failure";
      } else if ((m = /^MOCK_SLEEP\s+(\d+)$/.exec(line))) {
        await new Promise((r) => setTimeout(r, parseInt(m![1])));
      } else if (line === "MOCK_NO_DEFAULTS") {
        noDefaults = true;
      } else if (line === "MOCK_LIST_IN") {
        const files = await listFiles(path.join(job.cwd, "in"));
        await writeText(path.join(job.cwd, "out", "_in.txt"), files.join("\n") + "\n");
        written.add("_in.txt");
      }
      if (job.signal.aborted) {
        res.aborted = true;
        res.exitCode = 130;
        emit("end", { aborted: true });
        return res;
      }
    }

    if (fail) {
      res.exitCode = 1;
      res.error = fail;
      emit("end", { error: fail });
      return res;
    }

    if (!noDefaults) {
      for (const o of job.outputs) {
        if (written.has(o) || o.includes("*") || o.endsWith("/")) continue;
        if (o === "structured.json" && res.structuredOutput !== undefined) continue;
        await writeText(path.join(job.cwd, "out", o), `mock output for ${o}\n\n${job.prompt}\n`);
      }
    }

    emit("text", { text: "mock done" });
    res.exitCode = 0;
    res.sessionId = job.resumeSession ?? `mock-session-${++this.counter}`;
    res.costUsd = 0.001;
    res.tokens = { input: job.prompt.length, output: 42, cache_read: 0 };
    res.turns = 1;
    emit("end", { session_id: res.sessionId, total_cost_usd: res.costUsd });
    return res;
  }
}
