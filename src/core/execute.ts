import { promises as fs } from "node:fs";
import path from "node:path";
import Ajv2020Import from "ajv/dist/2020.js";
// ESM/CJS interop: under NodeNext the class arrives as the module's default
// export. Typed minimally to stay independent of ajv's own declarations.
type Validator = ((data: unknown) => boolean) & { errors?: unknown[] | null };
type AjvCtor = new (opts?: object) => { compile(schema: object): Validator; errorsText(errors?: unknown[] | null, opts?: object): string };
const Ajv2020: AjvCtor = (Ajv2020Import as unknown as { default?: AjvCtor }).default ?? (Ajv2020Import as unknown as AjvCtor);
import type { EngineRegistry } from "../engines/index.js";
import { platformShell, spawnProcess } from "../engines/proc.js";
import { ensureDir, hashFile, listFiles, nowIso, readJson, readJsonOrNull, writeJson, writeText } from "./fsutil.js";
import { collectInputSources, materialize, readItem } from "./materialize.js";
import type { RunStore } from "./runstore.js";
import { finalizeSignature } from "./signature.js";
import { computeSignature, engineConfigFor, engineName, missingOutputs, resolveBody, templateContext } from "./status.js";
import { resolveTemplate } from "./template.js";
import type { NodeAddr, NodeResult, NodeSpec, OutputInfo, ResultStatus, TraceEvent } from "./types.js";

export interface ExecEvent {
  type: "node";
  addr: NodeAddr;
  status: ResultStatus | "cached" | "starting";
  version?: string;
  message?: string;
}

export interface ExecContext {
  store: RunStore;
  engines: EngineRegistry;
  signal: AbortSignal;
  log: (msg: string) => void;
  emit: (e: ExecEvent) => void;
  env?: NodeJS.ProcessEnv;
}

export interface ExecOptions {
  /** Always create a new version, even if cached. */
  force?: boolean;
  feedback?: string;
}

export type ExecOutcome = { kind: "cached"; version: string } | { kind: "ran"; result: NodeResult; version: string };

/** Execute one node (SPEC §2, §4, §6). */
export async function executeNode(ctx: ExecContext, addr: NodeAddr, opts: ExecOptions = {}): Promise<ExecOutcome> {
  const { store } = ctx;
  const spec = store.manifest.nodes[addr.node];
  const item = await readItem(store, addr);
  const tctx = templateContext(store, spec, item);

  // Cache check (SPEC §6.3).
  const expected = spec.cache === "inputs" ? await computeSignature(store, addr) : null;
  const currentVersion = await store.current(addr);
  if (!opts.force && expected && currentVersion) {
    const vdir = store.versionDir(addr, currentVersion);
    const sig = await store.readSignature(vdir);
    const res = await store.readResult(vdir);
    if (sig && sig.hash === expected.hash && res?.status === "done" && (await missingOutputs(spec, vdir)).length === 0) {
      ctx.emit({ type: "node", addr, status: "cached", version: currentVersion });
      return { kind: "cached", version: currentVersion };
    }
  }

  const previousDir = currentVersion ? store.versionDir(addr, currentVersion) : null;
  const { name: version, dir: vdir } = await store.newVersion(addr);
  ctx.emit({ type: "node", addr, status: "starting", version });

  const started = nowIso();
  const result: NodeResult = {
    node: spec.id,
    version,
    mode: spec.mode,
    engine: spec.mode === "agent" || spec.mode === "chat" ? engineName(store, spec) : null,
    status: "running",
    started,
    ended: null,
    duration_ms: null,
    exit_code: null,
    session_id: null,
    cost_usd: null,
    tokens: null,
    turns: null,
    outputs: {},
    meta: {},
    error: null,
  };
  await store.writeResult(vdir, result);
  // Make the new version current immediately so `status` shows it running.
  await store.setCurrent(addr, version);

  const finish = async (status: ResultStatus, patch: Partial<NodeResult> = {}) => {
    Object.assign(result, patch, { status, ended: nowIso() });
    result.duration_ms = Date.parse(result.ended!) - Date.parse(started);
    if (status === "done" || status === "waiting") result.outputs = await outputInfos(vdir);
    await store.writeResult(vdir, result);
    if (expected) await store.writeSignature(vdir, expected);
    else if (spec.cache === "never") await store.writeSignature(vdir, finalizeSignature({ node: "never", engine: "", context: {}, inputs: {}, item: "", scripts: {} }));
    ctx.emit({ type: "node", addr, status, version, message: result.error ?? undefined });
    return { kind: "ran", result, version } as const;
  };

  try {
    // Materialize inputs.
    const sources = await collectInputSources(store, spec, addr, tctx);
    const mat = await materialize(store, spec, addr, vdir, tctx, sources, {
      previousOutDir: opts.force && previousDir ? path.join(previousDir, "out") : null,
      item,
    });

    // Prompt / feedback.
    let prompt = resolveBody(spec, tctx);
    if (opts.feedback) {
      await writeText(path.join(vdir, "feedback.md"), opts.feedback + "\n");
      prompt += `\n\n## Feedback on the previous attempt\n\n${opts.feedback}\n\nThe previous outputs are under in/_previous/. Produce improved outputs in out/.\n`;
    }
    const preamble = `Working directory contract: your inputs are under ./in (read-only), write every output into ./out. Declared outputs: ${spec.outputs.join(", ")}.\n\n`;
    const engine = spec.mode === "agent" || spec.mode === "chat" ? ctx.engines.get(engineName(store, spec)) : null;
    let schema: Record<string, unknown> | null = null;
    if (spec.schema) {
      schema = await readJson<Record<string, unknown>>(spec.schema);
      if (!engine || !engine.capabilities.includes("structured_output")) {
        prompt += `\n\n## Structured output\nWrite a JSON document matching this schema to out/structured.json:\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\n`;
      } else {
        prompt += `\n\nYour final answer must be the structured output; it will be saved as out/structured.json.`;
      }
    }
    if (spec.mode === "agent" || spec.mode === "chat") await writeText(path.join(vdir, "prompt.md"), preamble + prompt);

    const env = buildEnv(ctx, store, spec, addr, vdir);

    // Pre-checks (SPEC §7.2).
    for (const cmdT of spec.before) {
      const cmd = resolveTemplate(cmdT, tctx);
      const sh = platformShell();
      const stderr: string[] = [];
      const oc = await spawnProcess(sh.cmd, [...sh.args, cmd], {
        cwd: vdir,
        env,
        timeoutMs: 5 * 60_000,
        signal: ctx.signal,
        onStderrLine: (l) => stderr.push(l),
        onStdoutLine: (l) => stderr.push(l),
      });
      if (oc.code !== 0) {
        ctx.log(`${addrLabel(addr)}: blocked by \`${cmd}\`: ${stderr.slice(-3).join(" | ")}`);
        return await finish("blocked", { exit_code: oc.code, error: `pre-check failed: ${cmd}\n${stderr.slice(-20).join("\n")}` });
      }
    }

    const trace = traceWriter(path.join(vdir, "trace.jsonl"));

    if (spec.mode === "wait" || spec.mode === "chat") {
      await trace.close();
      const missing = await missingOutputs(spec, vdir);
      if (missing.length === 0) return await finish("done", { exit_code: 0 });
      return await finish("waiting");
    }

    if (spec.mode === "script") {
      const runCmd = resolveTemplate(pickRun(spec), tctx);
      const sh = platformShell();
      const out = fs.open(path.join(vdir, "stdout.log"), "w");
      const err = fs.open(path.join(vdir, "stderr.log"), "w");
      const [fo, fe] = await Promise.all([out, err]);
      trace.write({ t: nowIso(), type: "start", engine: "script", payload: { command: runCmd } });
      const oc = await spawnProcess(sh.cmd, [...sh.args, runCmd], {
        cwd: vdir,
        env,
        timeoutMs: spec.timeoutMs,
        signal: ctx.signal,
        onStdoutLine: (l) => {
          fo.write(l + "\n");
          trace.write({ t: nowIso(), type: "stdout", engine: "script", payload: l });
        },
        onStderrLine: (l) => {
          fe.write(l + "\n");
          trace.write({ t: nowIso(), type: "stderr", engine: "script", payload: l });
        },
      });
      await Promise.all([fo.close(), fe.close()]);
      trace.write({ t: nowIso(), type: "end", engine: "script", payload: { exit: oc.code, timedOut: oc.timedOut, aborted: oc.aborted } });
      await trace.close();
      const meta = (await readJsonOrNull<Record<string, unknown>>(path.join(vdir, "out", "_meta.json"))) ?? {};
      if (oc.aborted) return await finish("interrupted", { exit_code: oc.code, meta });
      if (oc.timedOut) return await finish("timeout", { exit_code: oc.code, meta, error: `timed out after ${spec.timeout}` });
      if (oc.code !== 0) return await finish("failed", { exit_code: oc.code, meta, error: oc.stderrTail || `exit ${oc.code}` });
      const missing = await missingOutputs(spec, vdir);
      if (missing.length) return await finish("missing_output", { exit_code: oc.code, meta, error: `missing outputs: ${missing.join(", ")}` });
      return await finish("done", { exit_code: 0, meta });
    }

    // agent
    const en = engineName(store, spec);
    const prevResult = previousDir ? await store.readResult(previousDir) : null;
    const resume = opts.force && prevResult?.session_id && engine!.capabilities.includes("resume") ? prevResult.session_id : null;
    const er = await engine!.run({
      cwd: vdir,
      prompt: preamble + prompt,
      tools: spec.tools,
      outputs: spec.outputs,
      schema,
      timeoutMs: spec.timeoutMs,
      resumeSession: resume,
      addDirs: mat.addDirs,
      config: engineConfigFor(store, spec),
      env,
      signal: ctx.signal,
      onEvent: (e: TraceEvent) => trace.write(e),
    });
    await trace.close();
    const patch: Partial<NodeResult> = {
      exit_code: er.exitCode,
      session_id: er.sessionId,
      cost_usd: er.costUsd,
      tokens: er.tokens,
      turns: er.turns,
    };
    if (er.structuredOutput !== undefined) await writeJson(path.join(vdir, "out", "structured.json"), er.structuredOutput);
    if (er.aborted) return await finish("interrupted", patch);
    if (er.timedOut) return await finish("timeout", { ...patch, error: `timed out after ${spec.timeout}` });
    if (er.exitCode !== 0) return await finish("failed", { ...patch, error: er.error ?? `exit ${er.exitCode}` });
    const missing = await missingOutputs(spec, vdir);
    if (missing.length) return await finish("missing_output", { ...patch, error: `missing outputs: ${missing.join(", ")}` + (er.error ? `\n${er.error}` : "") });
    if (schema) {
      const structured = await readJsonOrNull(path.join(vdir, "out", "structured.json"));
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      if (structured === null || !validate(structured)) {
        const errs = structured === null ? "out/structured.json is missing or not JSON" : ajv.errorsText(validate.errors, { separator: "; " });
        return await finish("schema_invalid", { ...patch, error: errs });
      }
    }
    return await finish("done", patch);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.log(`${addrLabel(addr)}: ${msg}`);
    return await finish("failed", { error: msg });
  }
}

/** For wait/chat nodes: mark done when the outputs have appeared. */
export async function settleWaiting(ctx: ExecContext, addr: NodeAddr): Promise<boolean> {
  const { store } = ctx;
  const spec = store.manifest.nodes[addr.node];
  const vdir = await store.currentDir(addr);
  if (!vdir) return false;
  const res = await store.readResult(vdir);
  if (!res || res.status !== "waiting") return false;
  if ((await missingOutputs(spec, vdir)).length) return false;
  res.status = "done";
  res.ended = nowIso();
  res.duration_ms = Date.parse(res.ended) - Date.parse(res.started);
  res.exit_code = 0;
  res.outputs = await outputInfos(vdir);
  await store.writeResult(vdir, res);
  ctx.emit({ type: "node", addr, status: "done", version: res.version });
  return true;
}

function pickRun(spec: NodeSpec): string {
  if (typeof spec.run === "string") return spec.run;
  const r = spec.run!;
  const chosen = process.platform === "win32" ? (r.windows ?? r.posix) : (r.posix ?? r.windows);
  if (!chosen) throw new Error("no run: command for this platform");
  return chosen;
}

function buildEnv(ctx: ExecContext, store: RunStore, spec: NodeSpec, addr: NodeAddr, vdir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(ctx.env ?? process.env) };
  env.FLOWY_IN = path.join(vdir, "in");
  env.FLOWY_OUT = path.join(vdir, "out");
  env.FLOWY_NODE = spec.id;
  env.FLOWY_RUN = store.run.id;
  env.FLOWY_WORKFLOW = spec.workflowDir;
  env.FLOWY_SCRIPTS = path.join(spec.workflowDir, "scripts");
  if (addr.item) {
    env.FLOWY_FOREACH = addr.item.foreach;
    env.FLOWY_ITEM = addr.item.id;
  }
  for (const [k, v] of Object.entries(store.run.inputs)) env[`FLOWY_INPUT_${k.toUpperCase()}`] = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  const unset = (store.manifest.engine as Record<string, unknown>).env_unset;
  if (Array.isArray(unset)) for (const k of unset) delete env[String(k)];
  return env;
}

async function outputInfos(vdir: string): Promise<Record<string, OutputInfo>> {
  const od = path.join(vdir, "out");
  const out: Record<string, OutputInfo> = {};
  for (const f of await listFiles(od)) {
    const p = path.join(od, f);
    const st = await fs.stat(p);
    out[f] = { bytes: st.size, sha256: st.size > 32 * 1024 * 1024 ? `size:${st.size}` : await hashFile(p) };
  }
  return out;
}

function traceWriter(file: string) {
  let chain: Promise<void> = ensureDir(path.dirname(file));
  return {
    write(e: TraceEvent) {
      chain = chain.then(() => fs.appendFile(file, JSON.stringify(e) + "\n")).catch(() => {});
    },
    close() {
      return chain;
    },
  };
}

export function addrLabel(a: NodeAddr): string {
  return a.item ? `${a.item.foreach}/${a.item.id}:${a.node}` : a.node;
}
