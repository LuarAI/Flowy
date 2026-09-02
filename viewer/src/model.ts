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
  };
}

export interface SourcePill {
  key: string;
  label: string;
  sub: string;
  entry: string;
  targets: string[];
}

export function collectSources(m: Manifest): SourcePill[] {
  const map = new Map<string, Set<string>>();
  for (const n of Object.values(m.nodes)) {
    const target = n.foreach ?? n.id;
    for (const c of n.context ?? []) {
      if (!map.has(c)) map.set(c, new Set());
      map.get(c)!.add(target);
    }
  }
  return [...map.entries()].map(([entry, targets], i) => {
    const clean = entry.replace(/\{\{\s*inputs\.([a-z_]+)\s*\}\}/g, "<$1>");
    const parts = clean.split("/").filter(Boolean);
    return {
      key: `s${i}-${parts[parts.length - 1] ?? clean}`,
      label: parts[parts.length - 1] ?? clean,
      sub: parts.length > 1 ? parts.slice(0, -1).join("/") : "source",
      entry,
      targets: [...targets],
    };
  });
}
