/**
 * Operations shared by the CLI and the viewer's server. Every viewer button
 * calls one of these; the CLI calls the same (SPEC §13).
 */
import path from "node:path";
import { compileWorkflow, topoOrder } from "./core/compile.js";
import { executeNode, settleWaiting, addrLabel, type ExecEvent } from "./core/execute.js";
import { ensureDir, exists, listFiles, readText, writeJson } from "./core/fsutil.js";
import { ensureLayout } from "./core/layout.js";
import { createRun, loadRun, resolveInputs, type RunStore } from "./core/runstore.js";
import { runWorkflow, runLockHolder, updateItemStates, type RunOptions, type RunSummary } from "./core/scheduler.js";
import { missingOutputs, nodeView, readVersionText, runOverview, type NodeView, type RunOverview } from "./core/status.js";
import type { ApproveField, LineState, Manifest, NodeAddr, NodeResult, RecipeSpec, TraceEvent } from "./core/types.js";
import { EngineRegistry } from "./engines/index.js";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

export { addrLabel };

export interface Logger {
  (msg: string): void;
}

export async function compile(dir: string, engines = new EngineRegistry()): Promise<Manifest> {
  const m = await compileWorkflow(dir, { engines: engines.names() });
  await ensureDir(path.join(dir, ".flowy"));
  await writeJson(path.join(dir, ".flowy", "manifest.json"), m);
  await ensureLayout(m);
  return m;
}

export interface StartOptions {
  inputs?: Record<string, unknown>;
  runId?: string;
  recompile?: boolean;
  until?: string;
  signal?: AbortSignal;
  log?: Logger;
  emit?: RunOptions["emit"];
  engines?: EngineRegistry;
  env?: NodeJS.ProcessEnv;
  tick?: number;
  cwd?: string;
}

/** Compile, create or resume a run, and drive it (SPEC §7). */
export async function run(dir: string, opts: StartOptions = {}): Promise<{ store: RunStore; summary: RunSummary }> {
  const engines = opts.engines ?? new EngineRegistry();
  let store = opts.runId ? await loadRun(dir, opts.runId) : null;
  if (store && opts.recompile) {
    store.manifest = await compile(dir, engines);
    await writeJson(path.join(store.run.dir, "manifest.json"), store.manifest);
  }
  if (!store) {
    const manifest = await compile(dir, engines);
    const inputs = resolveInputs(manifest, opts.inputs ?? {}, opts.cwd);
    store = await createRun(manifest, inputs, opts.runId);
  }
  const summary = await runWorkflow(store, {
    engines,
    signal: opts.signal ?? new AbortController().signal,
    until: opts.until,
    log: opts.log,
    emit: opts.emit,
    env: opts.env,
    tick: opts.tick,
  });
  return { store, summary };
}

export async function getStore(dir: string, runId?: string): Promise<RunStore> {
  const s = await loadRun(dir, runId);
  if (!s) throw new Error(runId ? `run "${runId}" not found` : `no runs yet in ${dir} — start one with \`flowy run\``);
  return s;
}

/**
 * Like getStore, but a missing run is never a wall: chatting on a fresh
 * workflow silently creates a scratch run (missing required inputs stay
 * null until a real run fills them).
 */
export async function ensureStore(dir: string, runId?: string, engines = new EngineRegistry()): Promise<{ store: RunStore; created: boolean }> {
  const existing = await loadRun(dir, runId);
  if (existing) return { store: existing, created: false };
  if (runId) throw new Error(`run "${runId}" not found`);
  const manifest = await compile(dir, engines);
  const store = await createRun(manifest, resolveInputs(manifest, {}, process.cwd(), { lenient: true }));
  return { store, created: true };
}

export async function overview(store: RunStore, checkStale = true): Promise<RunOverview> {
  await updateItemStates(store);
  return runOverview(store, { checkStale });
}

// ---- gates -------------------------------------------------------------------

export async function approve(store: RunStore, addr: NodeAddr, fields: Record<string, unknown>, by = "local"): Promise<void> {
  const spec = store.manifest.nodes[addr.node];
  if (!spec) throw new Error(`unknown node "${addr.node}"`);
  if (!spec.approve) throw new Error(`"${addr.node}" is not a gate (no approve: block)`);
  const v = await nodeView(store, addr, { checkStale: false });
  if (!v.version || !v.result) throw new Error(`"${addrLabel(addr)}" has not run yet`);
  if (v.result.status !== "done") throw new Error(`"${addrLabel(addr)}" is ${v.result.status}, not ready for approval`);
  const clean = coerceApproval(spec.approve, fields);
  await store.writeApproval(store.versionDir(addr, v.version), clean, by);
  await updateItemStates(store);
}

export function coerceApproval(schema: Record<string, ApproveField>, fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [k, f] of Object.entries(schema)) {
    const raw = fields[k];
    if (raw === undefined || raw === null || raw === "") {
      if (f.required) errors.push(`missing required field "${k}"`);
      continue;
    }
    switch (f.type) {
      case "integer": {
        const n = Number(raw);
        if (!Number.isInteger(n)) errors.push(`"${k}" must be an integer`);
        out[k] = n;
        break;
      }
      case "number": {
        const n = Number(raw);
        if (Number.isNaN(n)) errors.push(`"${k}" must be a number`);
        out[k] = n;
        break;
      }
      case "boolean":
        out[k] = raw === true || raw === "true" || raw === "yes" || raw === "1" || raw === 1;
        break;
      default:
        out[k] = String(raw);
    }
  }
  for (const k of Object.keys(fields)) if (!(k in schema)) errors.push(`unknown field "${k}" (declared: ${Object.keys(schema).join(", ")})`);
  if (errors.length) throw new Error(errors.join("; "));
  return out;
}

// ---- reruns / versions -------------------------------------------------------

export interface RerunOptions {
  feedback?: string;
  engines?: EngineRegistry;
  signal?: AbortSignal;
  log?: Logger;
  emit?: (e: ExecEvent) => void;
  env?: NodeJS.ProcessEnv;
}

export async function rerun(store: RunStore, addr: NodeAddr, opts: RerunOptions = {}): Promise<NodeResult> {
  if (!(addr.node in store.manifest.nodes)) throw new Error(`unknown node "${addr.node}"`);
  const holder = await runLockHolder(store);
  if (holder) throw new Error(`run is being driven by pid ${holder}; stop it first`);
  if (addr.item) await store.setItemState(addr.item.foreach, addr.item.id, "running");
  const out = await executeNode(
    {
      store,
      engines: opts.engines ?? new EngineRegistry(),
      signal: opts.signal ?? new AbortController().signal,
      log: opts.log ?? (() => {}),
      emit: opts.emit ?? (() => {}),
      env: opts.env,
    },
    addr,
    { force: true, feedback: opts.feedback },
  );
  await updateItemStates(store);
  if (out.kind === "cached") throw new Error("unexpected cache hit on a forced rerun");

  // A successful feedback rerun on a recipe node updates the recipe — the
  // workflow learns from the correction (SPEC §2.5).
  const spec = store.manifest.nodes[addr.node];
  if (out.result.status === "done" && opts.feedback && spec.mode === "chat" && spec.recipe) {
    try {
      const { crystallizeNode } = await import("./core/crystallize.js");
      await crystallizeNode(store, addr, opts.engines ?? new EngineRegistry(), { log: opts.log, env: opts.env });
    } catch (e) {
      opts.log?.(`(recipe not updated: ${(e as Error).message})`);
    }
  }
  return out.result;
}

export async function useVersion(store: RunStore, addr: NodeAddr, version: string): Promise<void> {
  const versions = await store.versions(addr);
  if (!versions.includes(version)) throw new Error(`"${addrLabel(addr)}" has versions ${versions.join(", ") || "(none)"}; "${version}" is not one of them`);
  await store.setCurrent(addr, version);
  await updateItemStates(store);
}

export async function skipItem(store: RunStore, foreach: string, itemId: string, skip = true): Promise<void> {
  if (!(foreach in store.manifest.foreach)) throw new Error(`unknown foreach "${foreach}"`);
  const items = await store.listItems(foreach);
  if (!items.some((i) => i.id === itemId)) throw new Error(`no item "${itemId}" under ${foreach}`);
  await store.setItemState(foreach, itemId, skip ? "skipped" : "pending");
  if (!skip) await updateItemStates(store);
}

export async function markDone(store: RunStore, addr: NodeAddr): Promise<void> {
  const spec = store.manifest.nodes[addr.node];
  if (!spec) throw new Error(`unknown node "${addr.node}"`);
  const vdir = await store.currentDir(addr);
  if (!vdir) throw new Error(`"${addrLabel(addr)}" has not started`);
  const missing = await missingOutputs(spec, vdir);
  if (missing.length) throw new Error(`cannot mark done — missing outputs in ${path.join(vdir, "out")}: ${missing.join(", ")}`);
  const ok = await settleWaiting({ store, engines: new EngineRegistry(), signal: new AbortController().signal, log: () => {}, emit: () => {} }, addr, { force: true });
  if (!ok) throw new Error(`"${addrLabel(addr)}" is not waiting`);
  await updateItemStates(store);
}

// ---- browser chat: one real engine turn per message --------------------------

export interface ChatTurn {
  text: string;
  session: string | null;
  costUsd: number | null;
  /** The human stopped this turn; partial work is kept and the session resumes. */
  stopped?: boolean;
}

/**
 * One back-and-forth turn in a node's conversation, from the viewer. Each
 * message is a real `claude -p --resume` turn in the node's isolated
 * directory; the transcript accumulates in the node's trace.jsonl.
 */
export async function sendChatMessage(
  store: RunStore,
  addr: NodeAddr,
  text: string,
  engines = new EngineRegistry(),
  opts: {
    emit?: (ev: { addr: NodeAddr; event: TraceEvent }) => void;
    env?: NodeJS.ProcessEnv;
    log?: Logger;
    signal?: AbortSignal;
    model?: string;
    /** Route permission prompts (tools outside the allowlist) to the chat card. */
    permission?: { url: string; token: string };
    /** Override the node's permission stance for this turn. */
    permissions?: "ask" | "ask-all" | "allow-all";
    /** Lines: replaces the default opening preamble on the first turn (ignored once a session exists). */
    preamble?: string | null;
    /** Lines: this message opens a station; recorded in the trace so the viewer shows a marker, not a bubble. */
    station?: { index: number; total: number; id: string; title: string; gate: string };
  } = {},
): Promise<ChatTurn> {
  const spec = store.manifest.nodes[addr.node];
  if (!spec) throw new Error(`unknown node "${addr.node}"`);
  if (spec.mode !== "chat" && spec.mode !== "agent") throw new Error(`"${addr.node}" is a ${spec.mode} node — only chats and agent steps hold conversations`);
  if (!text.trim()) throw new Error("empty message");
  let vdir = await store.currentDir(addr);
  if (!vdir) {
    const out = await executeNode({ store, engines, signal: new AbortController().signal, log: () => {}, emit: () => {} }, addr, { lenient: true });
    vdir = store.versionDir(addr, out.version);
  }
  const result = await store.readResult(vdir);
  const engine = engines.get(spec.engine ?? store.manifest.engine.default);
  if (!engine.capabilities.includes("resume")) throw new Error(`engine "${engine.name}" cannot hold a conversation`);
  const prepWarnings = Array.isArray(result?.meta?.warnings) ? (result!.meta.warnings as string[]) : [];

  let resume = result?.session_id ?? null;
  let fork = false;
  if (!resume && spec.continues) {
    const parentSpec = store.manifest.nodes[spec.continues];
    const parentAddr: NodeAddr = parentSpec?.foreach && addr.item ? { node: spec.continues, item: addr.item } : { node: spec.continues };
    const pdir = await store.currentDir(parentAddr);
    const pres = pdir ? await store.readResult(pdir) : null;
    if (pres?.session_id) {
      resume = pres.session_id;
      fork = true;
    }
  }

  // Inputs wired after the conversation started (a context file attached
  // mid-chat, an upstream that has since finished) land in in/ now, and the
  // message says so — no searching, no wasted tokens.
  const { engineConfigFor, templateContext } = await import("./core/status.js");
  const { readItem, refreshInputs } = await import("./core/materialize.js");
  let arrived: string[] = [];
  if (resume) {
    try {
      arrived = await refreshInputs(store, spec, addr, vdir, templateContext(store, spec, await readItem(store, addr)));
    } catch {
      /* best effort */
    }
  }
  const sent = arrived.length ? `(new under ./in since we started: ${arrived.map((a) => `in/${a}`).join(", ")})\n\n${text}` : text;

  const traceFile = path.join(vdir, "trace.jsonl");
  const append = (e: TraceEvent) => {
    void fs.appendFile(traceFile, JSON.stringify(e) + "\n").catch(() => {});
    opts.emit?.({ addr, event: e });
  };
  append({ t: new Date().toISOString(), type: "user", engine: engine.name, payload: opts.station ? { text: sent, station: opts.station } : { text: sent } });

  const refs = await fs.readFile(path.join(vdir, "in", "_refs.json"), "utf8").catch(() => "[]");
  const addDirs = [...new Set((JSON.parse(refs) as Array<{ path: string }>).map((r) => path.dirname(r.path)))];
  const warn = prepWarnings.length ? `Note: not everything is in place yet (${prepWarnings.join("; ")}) — work with what exists and say so when something is missing.\n\n` : "";
  const preamble = resume
    ? ""
    : opts.preamble != null
      ? opts.preamble + warn
      : `Working directory contract: your inputs are under ./in (read-only). Put a file in ./out only when a later step needs it; answer everything else in chat — never write a file just to hold a reply. Keep answers conversational and concise.\n\n${warn}${spec.body.trim() ? spec.body.trim() + "\n\n" : ""}`;
  const er = await engine.run({
    cwd: vdir,
    prompt: preamble + sent,
    tools: spec.tools,
    outputs: spec.outputs,
    schema: null,
    // A chat turn can hold real agent work; honor the node's `timeout:` (30m default).
    timeoutMs: spec.timeoutMs,
    resumeSession: resume,
    forkSession: fork,
    addDirs,
    config: { ...engineConfigFor(store, spec), ...(opts.model ? { model: opts.model } : {}) },
    env: opts.env ?? process.env,
    signal: opts.signal ?? new AbortController().signal,
    onEvent: append,
    permissionPrompt: opts.permission,
    autoAllow: (() => {
      const stance = opts.permissions ?? spec.permissions;
      return stance === "allow-all" ? ["*"] : stance === "ask-all" ? [] : spec.tools;
    })(),
  });
  if (result) {
    // The engine reports a session id only when a transcript actually exists,
    // so keep it even for an interrupted turn — the next message resumes the
    // conversation with all the work done so far. A turn that failed before a
    // transcript existed reports none, and stores none (no phantom ids).
    if (er.sessionId) result.session_id = er.sessionId;
    else if (er.exitCode === 0) result.session_id = resume;
    result.cost_usd = (result.cost_usd ?? 0) + (er.costUsd ?? 0);
    if (er.tokens) {
      result.tokens = result.tokens
        ? { input: result.tokens.input + er.tokens.input, output: result.tokens.output + er.tokens.output, cache_read: result.tokens.cache_read + er.tokens.cache_read }
        : er.tokens;
    }
    result.turns = (result.turns ?? 0) + 1;
    await store.writeResult(vdir, result);
  }
  if (er.aborted) {
    // The human hit stop: not an error. The partial work stays in the trace
    // and the session (persisted above, from init) resumes on the next message.
    append({ t: new Date().toISOString(), type: "end", engine: engine.name, payload: { stopped: true } });
    return { text: er.text ?? "", session: result?.session_id ?? null, costUsd: er.costUsd, stopped: true };
  }
  if (er.exitCode !== 0) {
    if (er.timedOut)
      throw new Error(
        `the turn ran past this chat's ${spec.timeout} limit and was stopped — nothing is lost, the conversation is saved; send another message to pick up where it left off (raise it with \`timeout:\` in nodes/${spec.id}.md)`,
      );
    throw new Error(er.error ?? `the turn failed (exit ${er.exitCode})`);
  }
  await settleWaiting({ store, engines, signal: new AbortController().signal, log: () => {}, emit: () => {} }, addr);
  return { text: er.text ?? "", session: er.sessionId ?? resume, costUsd: er.costUsd };
}

// ---- chat & recipes ----------------------------------------------------------

export async function chat(
  store: RunStore,
  addr: NodeAddr,
  engines = new EngineRegistry(),
  env: NodeJS.ProcessEnv = process.env,
  opts: { log?: Logger } = {},
): Promise<{ code: number; crystallized: boolean }> {
  const spec = store.manifest.nodes[addr.node];
  if (!spec) throw new Error(`unknown node "${addr.node}"`);
  if (spec.mode !== "chat" && spec.mode !== "agent") throw new Error(`"${addr.node}" is a ${spec.mode} node; chat applies to chat and agent nodes`);
  let vdir = await store.currentDir(addr);
  if (!vdir) {
    // Prepare the version (materialize inputs, write prompt.md) without running an engine.
    const out = await executeNode({ store, engines, signal: new AbortController().signal, log: () => {}, emit: () => {} }, addr, { lenient: true });
    vdir = store.versionDir(addr, out.version);
  }
  const result = await store.readResult(vdir);
  const engine = engines.get(spec.engine ?? store.manifest.engine.default);
  if (!engine.interactive) throw new Error(`engine "${engine.name}" has no interactive mode`);
  const promptFile = path.join(vdir, "prompt.md");
  if (!(await exists(promptFile))) throw new Error(`no prompt.md in ${vdir}`);
  const refs = await fs.readFile(path.join(vdir, "in", "_refs.json"), "utf8").catch(() => "[]");
  const addDirs = [...new Set((JSON.parse(refs) as Array<{ path: string }>).map((r) => path.dirname(r.path)))];
  const { engineConfigFor } = await import("./core/status.js");
  const sessionId = result?.session_id ?? randomUUID();
  const code = await engine.interactive({
    cwd: vdir,
    promptFile,
    resumeSession: result?.session_id ?? null,
    sessionId,
    addDirs,
    config: engineConfigFor(store, spec),
    env,
  });
  if (result && !result.session_id) {
    result.session_id = sessionId;
    await store.writeResult(vdir, result);
  }
  const settled = await settleWaiting({ store, engines, signal: new AbortController().signal, log: () => {}, emit: () => {} }, addr);
  await updateItemStates(store);

  // A finished conversation on a chat node crystallizes into the recipe (SPEC §2.5).
  let crystallized = false;
  const done = settled || (await nodeView(store, addr, { checkStale: false })).status === "done";
  if (spec.mode === "chat" && done && engine.capabilities.includes("resume")) {
    try {
      const { crystallizeNode } = await import("./core/crystallize.js");
      await crystallizeNode(store, addr, engines, { log: opts.log, env });
      crystallized = true;
    } catch (e) {
      opts.log?.(`(recipe not learned: ${(e as Error).message})`);
    }
  }
  return { code, crystallized };
}

export async function crystallize(store: RunStore, addr: NodeAddr, engines = new EngineRegistry(), log?: Logger): Promise<{ recipe: string; file: string }> {
  const { crystallizeNode } = await import("./core/crystallize.js");
  return crystallizeNode(store, addr, engines, { log });
}

// ---- lines: a recipe followed station by station (SPEC §5.1) ----------------

export interface LineOptions {
  engines?: EngineRegistry;
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  emit?: (ev: { addr: NodeAddr; event: TraceEvent }) => void;
  onLine?: (feId: string, itemId: string, ls: LineState) => void;
  /** Per-turn plumbing from the server: an abort signal and the permission bridge; `done` releases them. */
  turnContext?: (addr: NodeAddr) => { signal?: AbortSignal; permission?: { url: string; token: string }; done: () => void };
}

function lineDeps(store: RunStore, opts: LineOptions): import("./core/lines.js").DriveDeps {
  const engines = opts.engines ?? new EngineRegistry();
  return {
    turn: async (addr, text, station, preamble, model) => {
      const tc = opts.turnContext?.(addr);
      try {
        const spec = store.manifest.nodes[addr.node];
        return await sendChatMessage(store, addr, text, engines, {
          emit: opts.emit,
          env: opts.env,
          log: opts.log,
          signal: tc?.signal,
          permission: tc?.permission,
          model: model ?? spec.model ?? undefined,
          preamble,
          station,
        });
      } finally {
        tc?.done();
      }
    },
    finish: async (addr) => {
      const vdir = await store.currentDir(addr);
      const res = vdir ? await store.readResult(vdir) : null;
      if (vdir && res && res.status !== "done") {
        const { outputInfos } = await import("./core/execute.js");
        res.status = "done";
        res.ended = new Date().toISOString();
        res.duration_ms = Date.parse(res.ended) - Date.parse(res.started);
        res.exit_code = 0;
        res.outputs = await outputInfos(vdir);
        await store.writeResult(vdir, res);
      }
      await updateItemStates(store);
    },
    log: opts.log,
    onChange: opts.onLine,
  };
}

/** Start lines for timetable entries (the departures sheet / `flowy depart`). Drives each to its first gate, `concurrency` at a time. */
export async function depart(store: RunStore, feId: string, picks: Array<{ id: string; style?: string | null }>, opts: LineOptions = {}): Promise<LineState[]> {
  const { createLine, driveLine, recipeOf } = await import("./core/lines.js");
  const { readTimetable } = await import("./core/recipe.js");
  const fe = store.manifest.foreach[feId];
  if (!fe || !fe.recipe) throw new Error(`"${feId}" is not a lines block`);
  const recipe = recipeOf(store, feId);
  const timetable = await readTimetable(fe.list!);
  const created: string[] = [];
  for (const p of picks) {
    const entry = timetable.find((e) => e.id === p.id);
    if (!entry) throw new Error(`"${p.id}" is not on the timetable (${path.relative(store.manifest.dir, fe.list!)})`);
    const style = p.style ?? recipe.defaultStyle;
    await createLine(store, feId, entry, style, timetable.indexOf(entry));
    created.push(entry.id);
  }
  const deps = lineDeps(store, opts);
  const results: LineState[] = [];
  const queue = [...created];
  const workers = Array.from({ length: Math.max(1, fe.concurrency) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      results.push(await driveLine(store, feId, id, deps));
    }
  });
  await Promise.all(workers);
  return results;
}

/** Move a line to its next station (a `confirm`/`you` gate answered), optionally carrying the human's words. */
export async function lineNext(store: RunStore, feId: string, itemId: string, opts: LineOptions = {}, text: string | null = null): Promise<LineState> {
  const { advanceLine } = await import("./core/lines.js");
  return advanceLine(store, feId, itemId, lineDeps(store, opts), text);
}

/** Run the current station again from its prompt (after a stop, a failure, or a restart). */
export async function lineResume(store: RunStore, feId: string, itemId: string, opts: LineOptions = {}): Promise<LineState> {
  const { driveLine, readLine } = await import("./core/lines.js");
  const ls = await readLine(store, feId, itemId);
  if (!ls) throw new Error(`no line "${feId}/${itemId}"`);
  if (ls.state === "running") throw new Error(`${feId}/${itemId} is mid-station`);
  if (ls.state === "done") throw new Error(`${feId}/${itemId} has already arrived`);
  return driveLine(store, feId, itemId, lineDeps(store, opts));
}

/** Give a waiting line the recipe as the workflow files have it now (its next station comes from the new one). */
export async function lineUpdate(store: RunStore, feId: string, itemId: string): Promise<LineState> {
  const { updateLineRecipe } = await import("./core/lines.js");
  return updateLineRecipe(store, feId, itemId);
}

/** Where every line is, for the map and the departures board. */
export async function linesOverview(store: RunStore, opts: { live?: (addr: NodeAddr) => boolean; liveRecipes?: Record<string, RecipeSpec> } = {}): Promise<LinesView[]> {
  const { readLine, lineRecipe } = await import("./core/lines.js");
  const { readTimetable } = await import("./core/recipe.js");
  const out: LinesView[] = [];
  for (const id of store.manifest.top) {
    const fe = store.manifest.foreach[id];
    if (!fe || !fe.recipe) continue;
    const recipe = store.manifest.recipes[fe.recipe];
    if (!recipe) continue;
    let timetable: Array<{ id: string; title: string; brief: string }> = [];
    let timetableError: string | null = null;
    try {
      timetable = await readTimetable(fe.list!);
    } catch (e) {
      timetableError = (e as Error).message;
    }
    const items = await store.listItems(id);
    const started = new Set(items.map((i) => i.id));
    const lines: LineView[] = [];
    for (const it of items) {
      const ls = await readLine(store, id, it.id);
      if (!ls) continue;
      const own = await lineRecipe(store, id, it.id);
      const addr: NodeAddr = { node: fe.nodes[0], item: { foreach: id, id: it.id } };
      const vdir = await store.currentDir(addr);
      const res = vdir ? await store.readResult(vdir) : null;
      const entry = it.item ?? {};
      lines.push({
        foreach: id,
        item: it.id,
        addr,
        title: typeof entry.title === "string" ? entry.title : it.id,
        brief: typeof entry.brief === "string" ? entry.brief : "",
        line: ls,
        steps: own.steps.map((s) => ({ id: s.id, title: s.title, gate: s.gate })),
        gate: own.steps[ls.step]?.gate ?? null,
        cost: res?.cost_usd ?? 0,
        live: opts.live?.(addr) ?? false,
        parked: it.state === "skipped",
      });
    }
    out.push({
      id,
      recipe,
      liveVersion: opts.liveRecipes?.[fe.recipe]?.version ?? recipe.version,
      timetable: timetable.map((e) => ({ id: e.id, title: e.title, brief: e.brief, started: started.has(e.id) })),
      timetableError,
      listFile: fe.list!,
      needs: fe.needs,
      lines,
    });
  }
  return out;
}

export interface LineView {
  foreach: string;
  item: string;
  addr: NodeAddr;
  title: string;
  brief: string;
  line: LineState;
  steps: Array<{ id: string; title: string; gate: string }>;
  gate: "auto" | "confirm" | "you" | null;
  cost: number;
  /** A turn is in flight right now (server-side knowledge). */
  live: boolean;
  parked: boolean;
}

export interface LinesView {
  id: string;
  recipe: RecipeSpec;
  liveVersion: number;
  timetable: Array<{ id: string; title: string; brief: string; started: boolean }>;
  timetableError: string | null;
  listFile: string;
  needs: string[];
  lines: LineView[];
}

/** Add an entry to a lines block's timetable (`lists/<id>.yaml`). */
export async function addTimetableEntry(store: RunStore, feId: string, entry: { title: string; brief?: string }): Promise<{ id: string; title: string; brief: string }> {
  const fe = store.manifest.foreach[feId];
  if (!fe || !fe.recipe) throw new Error(`"${feId}" is not a lines block`);
  if (!entry.title.trim()) throw new Error("give the line a title");
  const { appendTimetableEntry } = await import("./core/recipe.js");
  return appendTimetableEntry(fe.list!, entry);
}

/** Learn a station recipe from several finished conversations (SPEC §2.6). */
export async function distill(store: RunStore, name: string, chats: NodeAddr[], engines = new EngineRegistry(), opts: { log?: Logger; env?: NodeJS.ProcessEnv; model?: string } = {}) {
  const { distillRecipe } = await import("./core/distill.js");
  return distillRecipe(store, name, chats, engines, opts);
}

/** On startup: a line whose turn died with the previous process is not running any more. */
export async function reconcileLines(store: RunStore, live: (addr: NodeAddr) => boolean): Promise<void> {
  const { readLine, writeLine } = await import("./core/lines.js");
  for (const fe of Object.values(store.manifest.foreach)) {
    if (!fe.recipe) continue;
    for (const it of await store.listItems(fe.id)) {
      const ls = await readLine(store, fe.id, it.id);
      if (!ls || ls.state !== "running") continue;
      if (live({ node: fe.nodes[0], item: { foreach: fe.id, id: it.id } })) continue;
      ls.state = "waiting";
      ls.note = "interrupted (Flowy restarted mid-station) — resume the station, or talk to it";
      ls.waitingSince = new Date().toISOString();
      const last = ls.history[ls.history.length - 1];
      if (last && !last.ended) last.ended = new Date().toISOString();
      await writeLine(store, fe.id, it.id, ls);
    }
  }
}

// ---- inspection --------------------------------------------------------------

export interface VersionDetail {
  name: string;
  result: NodeResult | null;
  approval: Record<string, unknown> | null;
  current: boolean;
}

export interface NodeDetail {
  view: NodeView;
  versionDir: string | null;
  prompt: string | null;
  feedback: string | null;
  outputs: Array<{ path: string; bytes: number; text: string | null }>;
  inputs: string[];
  versions: VersionDetail[];
  trace: TraceEvent[];
  stderr: string | null;
}

export async function nodeDetail(store: RunStore, addr: NodeAddr, opts: { version?: string; traceLimit?: number } = {}): Promise<NodeDetail> {
  const view = await nodeView(store, addr);
  const version = opts.version ?? view.version;
  const vdir = version ? store.versionDir(addr, version) : null;
  const versions: VersionDetail[] = [];
  for (const v of view.versions) {
    const d = store.versionDir(addr, v);
    versions.push({ name: v, result: await store.readResult(d), approval: await store.readApproval(d), current: v === view.version });
  }
  const detail: NodeDetail = { view, versionDir: vdir, prompt: null, feedback: null, outputs: [], inputs: [], versions, trace: [], stderr: null };
  if (!vdir) return detail;
  detail.prompt = await readVersionText(vdir, "prompt.md");
  detail.feedback = await readVersionText(vdir, "feedback.md");
  detail.stderr = await readVersionText(vdir, "stderr.log", 64 * 1024);
  const od = path.join(vdir, "out");
  for (const f of await listFiles(od)) {
    const p = path.join(od, f);
    const st = await fs.stat(p);
    const textual = st.size <= 256 * 1024 && /\.(md|txt|json|yaml|yml|srt|csv|html|xml|otio|log)$/i.test(f);
    detail.outputs.push({ path: f, bytes: st.size, text: textual ? await readText(p) : null });
  }
  detail.inputs = await listFiles(path.join(vdir, "in"));
  detail.trace = await readTrace(vdir, opts.traceLimit ?? 2000);
  return detail;
}

export async function readTrace(vdir: string, limit = 2000): Promise<TraceEvent[]> {
  const f = path.join(vdir, "trace.jsonl");
  if (!(await exists(f))) return [];
  const lines = (await readText(f)).split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  const out: TraceEvent[] = [];
  for (const l of tail) {
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Text rendering of an overview for `flowy status`. */
export function formatOverview(o: RunOverview): string {
  const lines: string[] = [];
  lines.push(`run ${o.run.id}  (${o.run.workflow})  status: ${o.run.status}  cost: $${o.totals.cost_usd.toFixed(3)}  done ${o.totals.done}/${o.totals.total}`);
  const fmt = (v: NodeView, indent = "") => {
    const extra = [v.version ?? "", v.result?.cost_usd ? `$${v.result.cost_usd.toFixed(3)}` : "", v.result?.duration_ms ? `${(v.result.duration_ms / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" ");
    let note = "";
    if (v.status === "stale") note = `  ← ${v.staleReasons.slice(0, 2).join(", ")}`;
    if (v.status === "waiting" && v.hint) note = `  ← ${v.hint}`;
    if (v.status === "gate") note = `  ← flowy approve ${v.id}${v.addr.item ? ` --item ${v.addr.item.foreach}/${v.addr.item.id}` : ""} --set ${Object.keys(v.approveFields ?? {}).join("=… --set ")}=…`;
    if (["failed", "blocked", "missing_output", "schema_invalid", "timeout"].includes(v.status) && v.result?.error) note = `  ← ${v.result.error.split("\n")[0].slice(0, 100)}`;
    lines.push(`${indent}${pad(v.status, 14)} ${pad(v.id, 22)} ${extra}${note}`);
  };
  for (const n of o.nodes) fmt(n);
  for (const fe of o.foreach) {
    lines.push(`${pad(fe.expanded ? `foreach` : "pending", 14)} ${fe.id}  (${fe.items.length} item${fe.items.length === 1 ? "" : "s"} from ${fe.source})`);
    for (const it of fe.items) {
      lines.push(`  [${it.state}] ${it.id}${it.cost ? `  $${it.cost.toFixed(3)}` : ""}`);
      if (it.state !== "skipped" && it.state !== "orphaned") for (const v of it.nodes) fmt(v, "    ");
    }
  }
  if (o.pending.length) {
    lines.push("");
    lines.push("waiting on you:");
    for (const p of o.pending) lines.push(`  ${p.status === "gate" ? "approve" : "provide"} ${addrLabel(p.addr)}${p.hint ? ` — ${p.hint}` : ""}`);
  }
  return lines.join("\n");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function formatPlan(m: Manifest): string {
  const order = topoOrder(m);
  const lines = [`${m.name}: ${order.length} top-level step${order.length === 1 ? "" : "s"}`];
  for (const id of order) {
    if (id in m.foreach) {
      const fe = m.foreach[id];
      if (!fe.source) {
        const r = m.recipes[fe.recipe!];
        lines.push(`  ${id}  lines · recipe ${fe.recipe} v${r?.version ?? "?"} → [${(r?.steps ?? []).map((s) => s.id).join(" → ")}]${fe.needs.length ? `  (needs ${fe.needs.join(", ")})` : ""}`);
      } else lines.push(`  ${id}  foreach ${fe.source.node}.${fe.source.key} → [${fe.nodes.join(" → ")}]  (needs ${fe.needs.join(", ")})`);
    } else {
      const n = m.nodes[id];
      lines.push(`  ${id}  ${n.mode}${n.approve ? " · gate" : ""}${n.lock ? ` · lock ${n.lock}` : ""}${n.needs.length ? `  (needs ${n.needs.join(", ")})` : ""}`);
    }
  }
  return lines.join("\n");
}
