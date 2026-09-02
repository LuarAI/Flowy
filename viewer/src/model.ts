import type { ItemView, Manifest, NodeView } from "./client";

export const NEEDS_YOU = ["gate", "waiting"];
export const WRONG = ["failed", "blocked", "missing_output", "schema_invalid", "timeout", "interrupted"];

export function humanMode(mode: string, recipe?: boolean): string {
  if (mode === "chat") return recipe ? "knows the recipe" : "you + Claude, first time";
  return mode === "agent" ? "Claude does it" : mode === "wait" ? "you do it" : "runs a tool";
}

export function humanStatus(v: NodeView): string {
  switch (v.status) {
    case "done":
      return "done";
    case "running":
      return "working";
    case "gate":
      return "your call";
    case "waiting":
      return v.mode === "chat" ? "talk it through" : "waiting on you";
    case "stale":
      return "needs a refresh";
    case "pending":
      return "up next";
    case "skipped":
      return "parked";
    default:
      return WRONG.includes(v.status) ? "went wrong" : v.status;
  }
}

export function itemWorst(it: ItemView): { status: string; view: NodeView | null } {
  if (it.state === "skipped" || it.state === "orphaned") return { status: "parked", view: null };
  const order = [...WRONG, "gate", "waiting", "running", "stale", "pending", "done"];
  let worst: NodeView | null = null;
  for (const n of it.nodes) {
    if (!worst || order.indexOf(n.status) < order.indexOf(worst.status)) worst = n;
  }
  return { status: worst ? humanStatus(worst) : "up next", view: worst };
}

export function dotColor(status: string): string {
  if (["gate", "waiting", "your call", "waiting on you", "talk it through", "went wrong", ...WRONG].includes(status)) return "var(--accent)";
  if (["done"].includes(status)) return "#4c8a4f";
  if (["running", "working"].includes(status)) return "var(--ink)";
  return "var(--faint)";
}

export function placeholderView(m: Manifest, id: string): NodeView {
  const n = m.nodes[id];
  return {
    addr: { node: id },
    id,
    title: n?.title ?? id,
    mode: (n?.mode as NodeView["mode"]) ?? "agent",
    engine: "",
    status: "pending",
    version: null,
    versions: [],
    result: null,
    approval: null,
    gate: !!n?.approve,
    staleReasons: [],
    hint: null,
    lock: n?.lock ?? null,
    needs: n?.needs ?? [],
    outputs: n?.outputs ?? [],
    approveFields: null,
    recipe: n?.recipe ?? false,
    continues: n?.continues ?? null,
    brief: false,
    model: null,
    permissions: "ask",
  };
}

export interface SourcePill {
  key: string;
  label: string;
  sub: string;
  /** Which canvas vertex (node or foreach id) reads it, with the exact entry string that vertex's file uses. */
  targets: Array<{ id: string; entry: string }>;
}

/** One pill per FILE: `context/x.md` and `../context/x.md` are the same source. */
export function collectSources(m: Manifest): SourcePill[] {
  const map = new Map<string, Map<string, string>>(); // normalized -> target id -> exact entry
  for (const n of Object.values(m.nodes)) {
    const target = n.foreach ?? n.id;
    for (const c of n.context ?? []) {
      const norm = c.replace(/^(\.\.\/)+/, "");
      if (!map.has(norm)) map.set(norm, new Map());
      if (!map.get(norm)!.has(target)) map.get(norm)!.set(target, c);
    }
  }
  return [...map.entries()].map(([norm, targets]) => {
    const clean = norm.replace(/\{\{\s*inputs\.([a-z_]+)\s*\}\}/g, "<$1>");
    const parts = clean.split("/").filter(Boolean);
    return {
      key: norm,
      label: parts[parts.length - 1] ?? clean,
      sub: parts.length > 1 ? parts.slice(0, -1).join("/") : "source",
      targets: [...targets.entries()].map(([id, entry]) => ({ id, entry })),
    };
  });
}

/** A picked absolute path becomes workflow-relative when it lives inside the workflow. */
export function relativeEntry(p: string, workflowDir: string): string {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const np = norm(p);
  const nd = norm(workflowDir);
  if (np.toLowerCase().startsWith(nd.toLowerCase() + "/")) return np.slice(nd.length + 1);
  return np;
}

/** The entry string to write when attaching a pill to `targetId` (nested workflows need the ../ form). */
export function entryFor(pill: SourcePill, targetId: string, m: Manifest): string {
  const existing = pill.targets.find((t) => t.id === targetId)?.entry;
  if (existing) return existing;
  const targetIsNested = Object.values(m.nodes).some((n) => (n.foreach ?? n.id) === targetId && n.foreach);
  const nested = pill.targets.find((t) => t.entry.startsWith("../"))?.entry;
  const top = pill.targets.find((t) => !t.entry.startsWith("../"))?.entry;
  if (targetIsNested) return nested ?? `../${pill.key}`;
  return top ?? pill.key;
}
