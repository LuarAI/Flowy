import path from "node:path";
import fg from "fast-glob";
import { exists, hashFile, isDir, listFiles, readText, sha256 } from "./fsutil.js";
import { collectInputSources, hashSources, InputsNotReady, readItem } from "./materialize.js";
import type { RunStore } from "./runstore.js";
import { explainSignatureDiff, finalizeSignature, scriptTokens, type Signature } from "./signature.js";
import { resolveTemplate, type TemplateContext } from "./template.js";
import type { Approval, ItemState, NodeAddr, NodeResult, NodeSpec, NodeStatus } from "./types.js";

export function templateContext(store: RunStore, spec: NodeSpec, item: Record<string, unknown> | null): TemplateContext {
  return {
    inputs: store.run.inputs,
    run: { id: store.run.id, started: store.run.started, seed: store.run.seed },
    item,
    workflow: { dir: spec.workflowDir, scripts: path.join(spec.workflowDir, "scripts") },
  };
}

export function resolveBody(spec: NodeSpec, tctx: TemplateContext): string {
  return resolveTemplate(spec.body, tctx);
}

export function engineName(store: RunStore, spec: NodeSpec): string {
  return spec.engine ?? store.manifest.engine.default;
}

export function engineConfig(store: RunStore, name: string): Record<string, unknown> {
  const c = store.manifest.engine[name];
  return c && typeof c === "object" ? (c as Record<string, unknown>) : {};
}

/** Workflow-level engine config with the node's own model/effort overrides applied. */
export function engineConfigFor(store: RunStore, spec: NodeSpec): Record<string, unknown> {
  const base = engineConfig(store, engineName(store, spec));
  const out = { ...base };
  if (spec.model) out.model = spec.model;
  if (spec.effort) out.effort = spec.effort;
  return out;
}

/**
 * Compute what the node's signature would be right now (SPEC §6.3).
 * Returns null when an upstream has no current version yet.
 */
export async function computeSignature(store: RunStore, addr: NodeAddr): Promise<Signature | null> {
  const spec = store.manifest.nodes[addr.node];
  const item = await readItem(store, addr);
  const tctx = templateContext(store, spec, item);
  let sources;
  try {
    sources = await collectInputSources(store, spec, addr, tctx);
  } catch {
    // Missing upstream, unresolved template, absent context: the signature
    // simply cannot be computed yet — that means "not cached", never an error.
    return null;
  }
  const hashes = await hashSources(sources, store.manifest.link_threshold);
  const { body: _b, file: _f, ...fm } = spec;
  const nodeHash = sha256(JSON.stringify(fm) + "\n" + resolveBody(spec, tctx));
  const en = engineName(store, spec);
  const cfg = engineConfigFor(store, spec);
  const engineHash = sha256(JSON.stringify({ en, model: cfg.model ?? null, effort: cfg.effort ?? null }));
  const scripts: Record<string, string> = {};
  if (spec.mode === "script" && spec.run) {
    const cmd = typeof spec.run === "string" ? spec.run : `${spec.run.windows ?? ""} ${spec.run.posix ?? ""}`;
    const scriptsDir = path.join(spec.workflowDir, "scripts");
    for (const p of scriptTokens(resolveTemplate(cmd, tctx), scriptsDir)) if (await exists(p)) scripts[path.relative(spec.workflowDir, p)] = await hashFile(p);
  }
  return finalizeSignature({
    node: nodeHash,
    engine: engineHash,
    context: hashes.context,
    inputs: hashes.inputs,
    item: item ? sha256(JSON.stringify(item)) : "",
    scripts,
  });
}

/** Verify declared outputs exist in out/ (SPEC §2). Returns the missing declarations. */
export async function missingOutputs(spec: NodeSpec, versionDir: string): Promise<string[]> {
  const od = path.join(versionDir, "out");
  const missing: string[] = [];
  for (const o of spec.outputs) {
    if (o.endsWith("/")) {
      const d = path.join(od, o);
      if (!(await isDir(d)) || (await listFiles(d)).length === 0) missing.push(o);
    } else if (/[*?[\]{}]/.test(o)) {
      const hits = await fg(o, { cwd: od, onlyFiles: true });
      if (!hits.length) missing.push(o);
    } else if (!(await exists(path.join(od, o)))) missing.push(o);
  }
  return missing;
}

export interface NodeView {
  addr: NodeAddr;
  id: string;
  title: string;
  mode: NodeSpec["mode"];
  engine: string;
  status: NodeStatus;
  version: string | null;
  versions: string[];
  result: NodeResult | null;
  approval: Approval | null;
  gate: boolean;
  staleReasons: string[];
  hint: string | null;
  lock: string | null;
  needs: string[];
  outputs: string[];
  approveFields: NodeSpec["approve"];
  recipe: boolean;
  continues: string | null;
  /** Whether the node file carries a body (a brief/recipe) — the text itself stays in the file. */
  brief: boolean;
}

/** Derive a node's display/scheduling status (SPEC §6.4, §13). */
export async function nodeView(store: RunStore, addr: NodeAddr, opts: { checkStale?: boolean; itemState?: ItemState } = {}): Promise<NodeView> {
  const spec = store.manifest.nodes[addr.node];
  const versions = await store.versions(addr);
  const version = await store.current(addr);
  const vdir = version ? store.versionDir(addr, version) : null;
  const result = vdir ? await store.readResult(vdir) : null;
  const approval = vdir ? await store.readApproval(vdir) : null;
  const gate = !!spec.approve;
  const base: NodeView = {
    addr,
    id: spec.id,
    title: spec.title,
    mode: spec.mode,
    engine: engineName(store, spec),
    status: "pending",
    version,
    versions,
    result,
    approval,
    gate,
    staleReasons: [],
    hint: spec.hint,
    lock: spec.lock,
    needs: spec.needs,
    outputs: spec.outputs,
    approveFields: spec.approve,
    recipe: spec.recipe,
    continues: spec.continues,
    brief: spec.body.trim().length > 0,
  };
  if (opts.itemState === "skipped" || opts.itemState === "orphaned") return { ...base, status: opts.itemState };
  if (!vdir || !result) return base;
  switch (result.status) {
    case "running":
      return { ...base, status: "running" };
    case "waiting":
      return { ...base, status: "waiting" };
    case "done": {
      if (gate && !approval) return { ...base, status: "gate" };
      if (opts.checkStale !== false && spec.cache === "inputs") {
        const sig = await store.readSignature(vdir);
        let expected: Signature | null = null;
        try {
          expected = await computeSignature(store, addr);
        } catch {
          expected = null;
        }
        if (expected && sig && expected.hash !== sig.hash) return { ...base, status: "stale", staleReasons: explainSignatureDiff(sig, expected) };
        if (expected && !sig) return { ...base, status: "stale", staleReasons: ["no signature recorded"] };
      }
      return { ...base, status: "done" };
    }
    default:
      return { ...base, status: result.status };
  }
}

export interface ItemView {
  id: string;
  state: ItemState;
  item: Record<string, unknown> | null;
  nodes: NodeView[];
  cost: number;
}

export interface ForeachView {
  id: string;
  source: string;
  expanded: boolean;
  items: ItemView[];
  needs: string[];
  nodes: string[];
}

export interface RunOverview {
  run: RunStore["run"];
  nodes: NodeView[];
  foreach: ForeachView[];
  totals: { cost_usd: number; duration_ms: number; done: number; total: number };
  pending: Array<{ addr: NodeAddr; status: NodeStatus; hint: string | null }>;
}

export async function runOverview(store: RunStore, opts: { checkStale?: boolean } = {}): Promise<RunOverview> {
  const m = store.manifest;
  const nodes: NodeView[] = [];
  const foreach: ForeachView[] = [];
  let cost = 0;
  let duration = 0;
  let done = 0;
  let total = 0;
  const pending: RunOverview["pending"] = [];
  const tally = (v: NodeView) => {
    total++;
    if (v.status === "done" || v.status === "skipped") done++;
    if (v.result?.cost_usd) cost += v.result.cost_usd;
    if (v.result?.duration_ms) duration += v.result.duration_ms;
    // An open-ended conversation (chat with no declared outputs, no recipe)
    // is not a pending demand on the human — it's just a chat sitting there.
    const openChat = v.mode === "chat" && v.outputs.length === 0 && !v.recipe;
    if ((v.status === "gate" || v.status === "waiting") && !openChat) pending.push({ addr: v.addr, status: v.status, hint: v.hint });
  };
  for (const id of m.top) {
    if (id in m.foreach) {
      const fe = m.foreach[id];
      const items = await store.listItems(id);
      const views: ItemView[] = [];
      for (const it of items) {
        const nv: NodeView[] = [];
        let icost = 0;
        for (const nid of fe.nodes) {
          const v = await nodeView(store, { node: nid, item: { foreach: id, id: it.id } }, { ...opts, itemState: it.state });
          nv.push(v);
          if (it.state !== "skipped" && it.state !== "orphaned") tally(v);
          icost += v.result?.cost_usd ?? 0;
        }
        views.push({ id: it.id, state: it.state, item: it.item, nodes: nv, cost: icost });
      }
      foreach.push({ id, source: `${fe.source.node}.${fe.source.key}`, expanded: items.length > 0, items: views, needs: fe.needs, nodes: fe.nodes });
    } else {
      const v = await nodeView(store, { node: id }, opts);
      nodes.push(v);
      tally(v);
    }
  }
  return { run: store.run, nodes, foreach, totals: { cost_usd: cost, duration_ms: duration, done, total }, pending };
}

/** Read a small text file from a version dir, or null. */
export async function readVersionText(versionDir: string, rel: string, maxBytes = 512 * 1024): Promise<string | null> {
  const p = path.join(versionDir, rel);
  if (!(await exists(p))) return null;
  const t = await readText(p);
  return t.length > maxBytes ? t.slice(0, maxBytes) + `\n… (truncated, ${t.length} bytes)` : t;
}
