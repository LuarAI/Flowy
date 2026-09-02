import path from "node:path";
import YAML from "yaml";
import { exists, isDir, nowIso, parseDuration, readText } from "./fsutil.js";
import { parseFrontmatter, FrontmatterError } from "./frontmatter.js";
import { findTemplates } from "./template.js";
import type {
  ApproveField,
  Edge,
  EngineConfig,
  ForeachSpec,
  InputDecl,
  Manifest,
  NodeMode,
  NodeSpec,
} from "./types.js";

export interface CompileIssue {
  file: string;
  line?: number;
  message: string;
}

export class CompileError extends Error {
  constructor(public issues: CompileIssue[]) {
    super(
      `compile failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n` +
        issues.map((i) => `  ${i.file}${i.line ? `:${i.line}` : ""}: ${i.message}`).join("\n"),
    );
  }
}

export const KNOWN_ENGINES = ["claude", "codex", "gemini", "custom", "mock"];
const MODES: NodeMode[] = ["agent", "script", "wait", "chat"];
const INPUT_TYPES = ["string", "number", "boolean", "path", "list"];
const APPROVE_TYPES = ["string", "integer", "number", "boolean"];
const NODE_KEYS = new Set([
  "id",
  "title",
  "mode",
  "needs",
  "context",
  "tools",
  "outputs",
  "schema",
  "approve",
  "lock",
  "timeout",
  "cache",
  "before",
  "engine",
  "model",
  "effort",
  "recipe",
  "continues",
  "run",
  "hint",
]);
const WORKFLOW_KEYS = new Set([
  "flowy",
  "name",
  "description",
  "inputs",
  "engine",
  "concurrency",
  "stagger_ms",
  "link_threshold",
  "locks",
  "nodes",
]);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface RawForeach {
  foreach: string;
  id: string;
  workflow: string;
  key?: string;
  concurrency?: number;
}

export interface CompileOptions {
  engines?: string[];
}

/** Compile a workflow folder into a Manifest (SPEC §11). Throws CompileError. */
export async function compileWorkflow(dir: string, opts: CompileOptions = {}): Promise<Manifest> {
  const issues: CompileIssue[] = [];
  const root = path.resolve(dir);
  const wfFile = path.join(root, "workflow.yaml");
  const rel = (f: string) => path.relative(root, f) || ".";
  const engines = opts.engines ?? KNOWN_ENGINES;

  if (!(await exists(wfFile))) throw new CompileError([{ file: rel(wfFile), message: "workflow.yaml not found" }]);
  let raw: Record<string, unknown>;
  try {
    raw = (YAML.parse(await readText(wfFile)) ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new CompileError([{ file: rel(wfFile), message: `invalid YAML: ${(e as Error).message}` }]);
  }
  if (typeof raw !== "object" || raw === null) throw new CompileError([{ file: rel(wfFile), message: "workflow.yaml must be a mapping" }]);

  for (const k of Object.keys(raw)) if (!WORKFLOW_KEYS.has(k)) issues.push({ file: rel(wfFile), message: `unknown key "${k}"` });
  if (raw.flowy !== 0) issues.push({ file: rel(wfFile), message: `flowy: must be 0 (got ${JSON.stringify(raw.flowy)})` });
  if (typeof raw.name !== "string" || !raw.name) issues.push({ file: rel(wfFile), message: "name: is required" });

  // inputs
  const inputs: Record<string, InputDecl> = {};
  if (raw.inputs !== undefined) {
    if (typeof raw.inputs !== "object" || raw.inputs === null) issues.push({ file: rel(wfFile), message: "inputs: must be a mapping" });
    else
      for (const [name, decl] of Object.entries(raw.inputs as Record<string, unknown>)) {
        if (!/^[a-z_][a-z0-9_]*$/.test(name)) issues.push({ file: rel(wfFile), message: `inputs.${name}: invalid name` });
        const d = (decl ?? {}) as Record<string, unknown>;
        if (!INPUT_TYPES.includes(String(d.type))) issues.push({ file: rel(wfFile), message: `inputs.${name}.type must be one of ${INPUT_TYPES.join(", ")}` });
        inputs[name] = {
          type: d.type as InputDecl["type"],
          required: Boolean(d.required),
          default: d.default,
          description: typeof d.description === "string" ? d.description : undefined,
        };
      }
  }

  // engine
  let engine: EngineConfig = { default: "claude" };
  if (raw.engine !== undefined) {
    const e = raw.engine as Record<string, unknown>;
    if (typeof e !== "object" || e === null) issues.push({ file: rel(wfFile), message: "engine: must be a mapping" });
    else {
      engine = { ...(e as EngineConfig), default: typeof e.default === "string" ? e.default : "claude" };
      if (!engines.includes(engine.default)) issues.push({ file: rel(wfFile), message: `engine.default "${engine.default}" is not one of ${engines.join(", ")}` });
    }
  }

  const concurrency = intOr(raw.concurrency, 3);
  if (concurrency < 1) issues.push({ file: rel(wfFile), message: "concurrency must be >= 1" });
  const stagger_ms = intOr(raw.stagger_ms, 5000);
  const link_threshold = intOr(raw.link_threshold, 64 * 1024 * 1024);
  const locks: Record<string, number> = {};
  if (raw.locks !== undefined) {
    if (typeof raw.locks !== "object" || raw.locks === null) issues.push({ file: rel(wfFile), message: "locks: must be a mapping" });
    else
      for (const [k, v] of Object.entries(raw.locks as Record<string, unknown>)) {
        const n = intOr(v, NaN);
        if (!(n >= 1)) issues.push({ file: rel(wfFile), message: `locks.${k} must be an integer >= 1` });
        locks[k] = n;
      }
  }

  // An empty workflow is valid: a blank canvas the user builds onto.
  if (raw.nodes === undefined || raw.nodes === null) raw.nodes = [];
  if (!Array.isArray(raw.nodes)) {
    issues.push({ file: rel(wfFile), message: "nodes: must be a list" });
    throw new CompileError(issues);
  }

  const nodes: Record<string, NodeSpec> = {};
  const foreach: Record<string, ForeachSpec> = {};
  const top: string[] = [];
  const ids = new Set<string>();

  const claim = (id: string, file: string) => {
    if (ids.has(id)) issues.push({ file, message: `duplicate id "${id}"` });
    ids.add(id);
  };

  // Pass 1: load everything.
  for (const entry of raw.nodes as unknown[]) {
    if (typeof entry === "string") {
      const spec = await loadNode(root, entry, null, issues, rel);
      if (spec) {
        claim(spec.id, rel(spec.file));
        nodes[spec.id] = spec;
        top.push(spec.id);
      }
    } else if (entry && typeof entry === "object" && "foreach" in (entry as object)) {
      const fe = entry as RawForeach;
      if (typeof fe.id !== "string" || !ID_RE.test(fe.id)) {
        issues.push({ file: rel(wfFile), message: `foreach entry needs an id matching ${ID_RE}` });
        continue;
      }
      if (typeof fe.workflow !== "string") {
        issues.push({ file: rel(wfFile), message: `foreach "${fe.id}": workflow: (folder) is required` });
        continue;
      }
      const m = /^([a-z0-9-]+)\.([A-Za-z0-9_]+)$/.exec(String(fe.foreach));
      if (!m) {
        issues.push({ file: rel(wfFile), message: `foreach "${fe.id}": source must be "<node>.<key>" (got ${JSON.stringify(fe.foreach)})` });
        continue;
      }
      const nestedDir = path.resolve(root, fe.workflow);
      if (!(await isDir(nestedDir))) {
        issues.push({ file: rel(wfFile), message: `foreach "${fe.id}": workflow folder not found: ${fe.workflow}` });
        continue;
      }
      claim(fe.id, rel(wfFile));
      const nestedIds = await loadNested(nestedDir, fe.id, nodes, issues, rel, claim);
      foreach[fe.id] = {
        id: fe.id,
        source: { node: m[1], key: m[2] },
        workflowDir: nestedDir,
        key: typeof fe.key === "string" ? fe.key : null,
        concurrency: intOr(fe.concurrency, 2),
        nodes: nestedIds,
        needs: [],
      };
      top.push(fe.id);
    } else {
      issues.push({ file: rel(wfFile), message: `nodes: entry must be a node id or a foreach block (got ${JSON.stringify(entry)})` });
    }
  }

  // Pass 2: resolve references.
  const topSet = new Set(top);
  const edges: Edge[] = [];

  for (const spec of Object.values(nodes)) {
    const file = rel(spec.file);
    if (spec.engine && !engines.includes(spec.engine)) issues.push({ file, message: `engine "${spec.engine}" is not one of ${engines.join(", ")}` });
    if (spec.continues) {
      const parent = nodes[spec.continues];
      if (parent && parent.mode !== "agent" && parent.mode !== "chat") issues.push({ file, message: `continues "${spec.continues}": can only continue an agent or chat node's session` });
      if (parent && (parent.engine ?? null) !== (spec.engine ?? null)) issues.push({ file, message: `continues "${spec.continues}": both nodes must use the same engine` });
    }
    if (spec.lock && !(spec.lock in locks)) issues.push({ file, message: `lock "${spec.lock}" is not declared under locks: in workflow.yaml` });
    for (const t of findTemplates(spec.body + " " + spec.context.join(" ") + " " + (typeof spec.run === "string" ? spec.run : JSON.stringify(spec.run ?? "")) + " " + spec.before.join(" "))) {
      if (t.ns === "inputs" && !(t.key in inputs)) issues.push({ file, message: `references {{inputs.${t.key}}} which is not declared` });
      if (t.ns === "item" && !spec.foreach) issues.push({ file, message: `uses {{item.${t.key}}} outside a foreach` });
    }
    for (const dep of spec.needs) {
      if (dep === spec.id) {
        issues.push({ file, message: `needs itself` });
        continue;
      }
      if (spec.foreach) {
        const fe = foreach[spec.foreach];
        if (fe.nodes.includes(dep)) {
          edges.push({ from: dep, to: spec.id });
        } else if (dep in nodes && !nodes[dep].foreach) {
          if (!fe.needs.includes(dep)) fe.needs.push(dep);
        } else if (dep in foreach) {
          issues.push({ file, message: `needs "${dep}": a nested node cannot depend on a foreach` });
        } else if (dep in nodes) {
          issues.push({ file, message: `needs "${dep}": that node belongs to another foreach` });
        } else {
          issues.push({ file, message: `needs "${dep}": unknown node` });
        }
      } else {
        if (topSet.has(dep)) edges.push({ from: dep, to: spec.id });
        else if (dep in nodes) issues.push({ file, message: `needs "${dep}": that node is inside a foreach; depend on the foreach id instead` });
        else issues.push({ file, message: `needs "${dep}": unknown node` });
      }
    }
  }

  for (const fe of Object.values(foreach)) {
    const src = nodes[fe.source.node];
    if (!src || src.foreach) {
      issues.push({ file: rel(wfFile), message: `foreach "${fe.id}": source node "${fe.source.node}" is not a top-level node` });
    } else {
      const hasJson = src.outputs.includes(`${fe.source.key}.json`) || src.outputs.includes("structured.json");
      if (!src.schema && !hasJson) issues.push({ file: rel(src.file), message: `foreach "${fe.id}" reads "${fe.source.key}" but this node has neither schema: nor an output named ${fe.source.key}.json` });
      if (!fe.needs.includes(fe.source.node)) fe.needs.unshift(fe.source.node);
    }
    for (const dep of fe.needs) edges.push({ from: dep, to: fe.id });
  }

  // Cycles (top-level and per nested workflow).
  const topEdges = edges.filter((e) => topSet.has(e.from) && topSet.has(e.to));
  const cyc = findCycle(top, topEdges);
  if (cyc) issues.push({ file: rel(wfFile), message: `cycle: ${cyc.join(" -> ")}` });
  for (const fe of Object.values(foreach)) {
    const inner = edges.filter((e) => fe.nodes.includes(e.from) && fe.nodes.includes(e.to));
    const c = findCycle(fe.nodes, inner);
    if (c) issues.push({ file: rel(path.join(fe.workflowDir, "workflow.yaml")), message: `cycle: ${c.join(" -> ")}` });
    // a nested node must not reference a top-level node downstream of this foreach
    const downstream = reachable(fe.id, topEdges);
    for (const dep of fe.needs) if (downstream.has(dep)) issues.push({ file: rel(wfFile), message: `foreach "${fe.id}": nested nodes depend on "${dep}", which is downstream of the foreach (cycle)` });
  }

  if (issues.length) throw new CompileError(issues);

  return {
    flowy: 0,
    name: String(raw.name),
    description: typeof raw.description === "string" ? raw.description : "",
    dir: root,
    compiledAt: nowIso(),
    inputs,
    engine,
    concurrency,
    stagger_ms,
    link_threshold,
    locks,
    nodes,
    foreach,
    top,
    edges,
  };
}

async function loadNested(
  nestedDir: string,
  feId: string,
  nodes: Record<string, NodeSpec>,
  issues: CompileIssue[],
  rel: (f: string) => string,
  claim: (id: string, file: string) => void,
): Promise<string[]> {
  const wfFile = path.join(nestedDir, "workflow.yaml");
  if (!(await exists(wfFile))) {
    issues.push({ file: rel(wfFile), message: "nested workflow.yaml not found" });
    return [];
  }
  let raw: Record<string, unknown>;
  try {
    raw = (YAML.parse(await readText(wfFile)) ?? {}) as Record<string, unknown>;
  } catch (e) {
    issues.push({ file: rel(wfFile), message: `invalid YAML: ${(e as Error).message}` });
    return [];
  }
  for (const k of Object.keys(raw)) if (!["flowy", "name", "description", "nodes"].includes(k)) issues.push({ file: rel(wfFile), message: `unknown key "${k}" (nested workflows declare only flowy, name, description, nodes)` });
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    issues.push({ file: rel(wfFile), message: "nodes: must be a non-empty list" });
    return [];
  }
  const out: string[] = [];
  for (const entry of raw.nodes as unknown[]) {
    if (typeof entry !== "string") {
      issues.push({ file: rel(wfFile), message: "nested workflows cannot contain foreach blocks in this version" });
      continue;
    }
    const spec = await loadNode(nestedDir, entry, feId, issues, rel);
    if (spec) {
      claim(spec.id, rel(spec.file));
      nodes[spec.id] = spec;
      out.push(spec.id);
    }
  }
  return out;
}

async function loadNode(
  wfDir: string,
  id: string,
  feId: string | null,
  issues: CompileIssue[],
  rel: (f: string) => string,
): Promise<NodeSpec | null> {
  const file = path.join(wfDir, "nodes", `${id}.md`);
  const f = rel(file);
  if (!ID_RE.test(id)) {
    issues.push({ file: rel(path.join(wfDir, "workflow.yaml")), message: `node id "${id}" must match ${ID_RE}` });
    return null;
  }
  if (!(await exists(file))) {
    issues.push({ file: f, message: "node file not found" });
    return null;
  }
  let fm;
  try {
    fm = parseFrontmatter(await readText(file));
  } catch (e) {
    issues.push({ file: f, line: 1, message: (e as FrontmatterError).message });
    return null;
  }
  const d = fm.data;
  const L = (k: string) => fm.lines[k];
  const push = (k: string, message: string) => issues.push({ file: f, line: L(k), message });

  for (const k of Object.keys(d)) if (!NODE_KEYS.has(k)) push(k, `unknown field "${k}"`);
  if (d.id !== id) push("id", `id must equal the filename ("${id}")`);
  const mode = d.mode as NodeMode;
  if (!MODES.includes(mode)) push("mode", `mode must be one of ${MODES.join(", ")}`);

  const strList = (k: string, dflt: string[]): string[] => {
    const v = d[k];
    if (v === undefined || v === null) return dflt;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      push(k, `${k} must be a list of strings`);
      return dflt;
    }
    return v as string[];
  };

  const needs = strList("needs", []);
  const context = strList("context", []);
  // A chat is a working conversation: it gets real tools by default.
  const tools = strList("tools", mode === "chat" ? ["Read", "Write", "Edit", "Bash", "Glob", "Grep"] : ["Read", "Write"]);
  const outputs = strList("outputs", []);
  // Chats may be open-ended (no declared outputs); every other mode must produce files.
  if (outputs.length === 0 && mode !== "chat") push("outputs", "outputs: must declare at least one file");
  for (const o of outputs) if (path.isAbsolute(o) || o.startsWith("..")) push("outputs", `output "${o}" must be relative to out/`);
  const before = strList("before", []);
  for (const b of before) if (!b.trim()) push("before", "before: commands must be non-empty strings");

  let schema: string | null = null;
  if (d.schema !== undefined && d.schema !== null) {
    if (typeof d.schema !== "string") push("schema", "schema must be a path");
    else {
      schema = path.resolve(wfDir, d.schema);
      if (!(await exists(schema))) push("schema", `schema file not found: ${d.schema}`);
    }
  }

  let approve: Record<string, ApproveField> | null = null;
  if (d.approve !== undefined && d.approve !== null) {
    if (typeof d.approve !== "object" || Array.isArray(d.approve)) push("approve", "approve must be a mapping of field -> {type, required?, description?}");
    else {
      approve = {};
      for (const [k, v] of Object.entries(d.approve as Record<string, unknown>)) {
        const fld = (v ?? {}) as Record<string, unknown>;
        if (!APPROVE_TYPES.includes(String(fld.type))) push("approve", `approve.${k}.type must be one of ${APPROVE_TYPES.join(", ")}`);
        if (k.startsWith("_")) push("approve", `approve.${k}: names starting with _ are reserved`);
        approve[k] = { type: fld.type as ApproveField["type"], required: Boolean(fld.required), description: typeof fld.description === "string" ? fld.description : undefined };
      }
      if (Object.keys(approve).length === 0) push("approve", "approve: must declare at least one field");
    }
  }

  const lock = d.lock === undefined || d.lock === null ? null : String(d.lock);
  const timeout = d.timeout === undefined || d.timeout === null ? "30m" : String(d.timeout);
  let timeoutMs = 0;
  try {
    timeoutMs = parseDuration(timeout);
  } catch {
    push("timeout", `invalid timeout "${timeout}"`);
  }
  const cache = d.cache === undefined || d.cache === null ? "inputs" : String(d.cache);
  if (cache !== "inputs" && cache !== "never") push("cache", 'cache must be "inputs" or "never"');
  const engine = d.engine === undefined || d.engine === null ? null : String(d.engine);
  const model = d.model === undefined || d.model === null ? null : String(d.model);
  const effort = d.effort === undefined || d.effort === null ? null : String(d.effort);
  if ((model || effort) && mode !== "agent" && mode !== "chat") push(model ? "model" : "effort", "model/effort apply only to agent and chat nodes");
  const recipe = d.recipe === true;
  if (d.recipe !== undefined && typeof d.recipe !== "boolean") push("recipe", "recipe must be true or false");
  if (recipe && mode !== "chat") push("recipe", "recipe applies only to chat nodes (agent bodies are already the instruction)");
  const continues = d.continues === undefined || d.continues === null ? null : String(d.continues);
  if (continues && mode !== "agent" && mode !== "chat") push("continues", "continues applies only to agent and chat nodes");
  if (continues && !needs.includes(continues)) needs.push(continues); // a branch depends on its parent

  let run: NodeSpec["run"] = null;
  if (mode === "script") {
    if (typeof d.run === "string" && d.run.trim()) run = d.run;
    else if (d.run && typeof d.run === "object") {
      const r = d.run as Record<string, unknown>;
      run = { windows: typeof r.windows === "string" ? r.windows : undefined, posix: typeof r.posix === "string" ? r.posix : undefined };
      if (!run.windows && !run.posix) push("run", "run: must have windows: and/or posix:");
    } else push("run", "script nodes require run:");
  } else if (d.run !== undefined) push("run", "run: is only valid for script nodes");

  const hint = d.hint === undefined || d.hint === null ? null : String(d.hint);
  if (hint && mode !== "wait" && mode !== "chat") push("hint", "hint: is only valid for wait and chat nodes");

  for (const c of context) {
    if (c.includes("{{")) continue;
    const abs = path.resolve(wfDir, c);
    if (!(await exists(abs))) push("context", `context path not found: ${c}`);
  }

  if (mode === "agent" && !fm.body.trim()) issues.push({ file: f, line: fm.bodyLine, message: "agent nodes need a prompt body" });

  return {
    id,
    title: typeof d.title === "string" ? d.title : id,
    mode,
    needs,
    context,
    tools,
    outputs,
    schema,
    approve,
    lock,
    timeout,
    timeoutMs,
    cache: cache as "inputs" | "never",
    before,
    engine,
    model,
    effort,
    recipe,
    continues,
    run,
    hint,
    body: fm.body,
    file,
    workflowDir: wfDir,
    foreach: feId,
  };
}

function intOr(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

export function findCycle(vertices: string[], edges: Edge[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const v of vertices) adj.set(v, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let found: string[] | null = null;
  const visit = (v: string) => {
    if (found) return;
    state.set(v, 1);
    stack.push(v);
    for (const w of adj.get(v) ?? []) {
      const s = state.get(w) ?? 0;
      if (s === 1) {
        found = [...stack.slice(stack.indexOf(w)), w];
        return;
      }
      if (s === 0) visit(w);
    }
    stack.pop();
    state.set(v, 2);
  };
  for (const v of vertices) if ((state.get(v) ?? 0) === 0) visit(v);
  return found;
}

export function reachable(from: string, edges: Edge[]): Set<string> {
  const out = new Set<string>();
  const q = [from];
  while (q.length) {
    const v = q.pop()!;
    for (const e of edges) if (e.from === v && !out.has(e.to)) {
      out.add(e.to);
      q.push(e.to);
    }
  }
  return out;
}

/** Topological order of the top-level vertices. */
export function topoOrder(manifest: Manifest): string[] {
  const indeg = new Map<string, number>(manifest.top.map((v) => [v, 0]));
  const topSet = new Set(manifest.top);
  for (const e of manifest.edges) if (topSet.has(e.from) && topSet.has(e.to)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const q = manifest.top.filter((v) => indeg.get(v) === 0);
  const out: string[] = [];
  while (q.length) {
    const v = q.shift()!;
    out.push(v);
    for (const e of manifest.edges) if (e.from === v && topSet.has(e.to)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) q.push(e.to);
    }
  }
  return out;
}

/** Ancestors (transitive upstream) of a vertex in the top-level graph, including nested-to-top edges. */
export function ancestorsOf(manifest: Manifest, id: string): Set<string> {
  const out = new Set<string>();
  const q = [id];
  while (q.length) {
    const v = q.pop()!;
    for (const e of manifest.edges) if (e.to === v && !out.has(e.from)) {
      out.add(e.from);
      q.push(e.from);
    }
    const fe = manifest.foreach[v];
    if (fe) for (const d of fe.needs) if (!out.has(d)) {
      out.add(d);
      q.push(d);
    }
  }
  return out;
}
