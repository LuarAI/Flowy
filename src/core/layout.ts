import path from "node:path";
import { exists, readJsonOrNull, writeJson } from "./fsutil.js";
import type { Manifest } from "./types.js";

/** JSON Canvas (https://jsoncanvas.org) — Flowy uses positions only (SPEC §10). */
export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  color?: string;
  [k: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  [k: string]: unknown;
}

export interface Canvas {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [k: string]: unknown;
}

const W = 220;
const H = 72;
const GAP_X = 60;
const GAP_Y = 90;

export function layoutFile(dir: string): string {
  return path.join(dir, "layout.canvas");
}

export async function readLayout(dir: string): Promise<Canvas | null> {
  const c = await readJsonOrNull<Canvas>(layoutFile(dir));
  if (!c || !Array.isArray(c.nodes)) return null;
  if (!Array.isArray(c.edges)) c.edges = [];
  return c;
}

export async function writeLayout(dir: string, canvas: Canvas): Promise<void> {
  await writeJson(layoutFile(dir), canvas);
}

/** Longest-path layering of the top-level graph; returns depth per vertex. */
function layers(manifest: Manifest): Map<string, number> {
  const depth = new Map<string, number>();
  const topSet = new Set(manifest.top);
  const preds = new Map<string, string[]>();
  for (const v of manifest.top) preds.set(v, []);
  for (const e of manifest.edges) if (topSet.has(e.from) && topSet.has(e.to)) preds.get(e.to)!.push(e.from);
  const visit = (v: string): number => {
    if (depth.has(v)) return depth.get(v)!;
    depth.set(v, 0);
    const d = Math.max(-1, ...preds.get(v)!.map(visit)) + 1;
    depth.set(v, d);
    return d;
  };
  for (const v of manifest.top) visit(v);
  return depth;
}

function nodeText(manifest: Manifest, id: string): string {
  if (id in manifest.foreach) {
    const fe = manifest.foreach[id];
    return `${id}\nforeach ${fe.source.node}.${fe.source.key}: ${fe.nodes.join(" → ")}`;
  }
  const n = manifest.nodes[id];
  const bits: string[] = [n.mode];
  if (n.approve) bits.push("gate");
  if (n.lock) bits.push(`lock ${n.lock}`);
  return `${id}\n${bits.join(" · ")}`;
}

/** Generate a fresh canvas from the manifest (vertical flow, one layer per row). */
export function generateLayout(manifest: Manifest): Canvas {
  const depth = layers(manifest);
  const rows = new Map<number, string[]>();
  for (const v of manifest.top) {
    const d = depth.get(v) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d)!.push(v);
  }
  const nodes: CanvasNode[] = [];
  for (const [d, ids] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, i) => {
      const isFe = id in manifest.foreach;
      nodes.push({ id, type: "text", text: nodeText(manifest, id), x: i * (W + GAP_X), y: d * (H + GAP_Y), width: isFe ? W + 120 : W, height: isFe ? H + 24 : H });
    });
  }
  return { nodes, edges: topEdges(manifest) };
}

function topEdges(manifest: Manifest): CanvasEdge[] {
  const topSet = new Set(manifest.top);
  const seen = new Set<string>();
  const out: CanvasEdge[] = [];
  for (const e of manifest.edges) {
    if (!topSet.has(e.from) || !topSet.has(e.to)) continue;
    const id = `${e.from}->${e.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, fromNode: e.from, toNode: e.to });
  }
  return out;
}

/**
 * Reconcile an existing canvas with the manifest: keep positions and any
 * extra properties for ids that still exist, place new ids, drop vanished
 * ones, and regenerate edges (preserving extra props on edges that persist).
 */
export function mergeLayout(existing: Canvas | null, manifest: Manifest): { canvas: Canvas; changed: boolean } {
  const fresh = generateLayout(manifest);
  if (!existing) return { canvas: fresh, changed: true };
  const byId = new Map(existing.nodes.map((n) => [n.id, n]));
  let changed = false;
  const nodes: CanvasNode[] = fresh.nodes.map((f) => {
    const old = byId.get(f.id);
    if (!old) {
      changed = true;
      return f;
    }
    const text = nodeText(manifest, f.id);
    if (old.text !== text) changed = true;
    return { ...old, text, width: old.width || f.width, height: old.height || f.height };
  });
  if (existing.nodes.some((n) => !manifest.top.includes(n.id))) changed = true;
  const oldEdges = new Map(existing.edges.map((e) => [`${e.fromNode}->${e.toNode}`, e]));
  const edges: CanvasEdge[] = fresh.edges.map((e) => {
    const old = oldEdges.get(e.id);
    if (!old) changed = true;
    return old ? { ...old, id: old.id ?? e.id } : e;
  });
  if (existing.edges.length !== edges.length) changed = true;
  const { nodes: _n, edges: _e, ...rest } = existing;
  return { canvas: { ...rest, nodes, edges }, changed };
}

/** Ensure layout.canvas exists and matches the manifest; returns the canvas. */
export async function ensureLayout(manifest: Manifest): Promise<Canvas> {
  const existing = await readLayout(manifest.dir);
  const { canvas, changed } = mergeLayout(existing, manifest);
  if (changed || !(await exists(layoutFile(manifest.dir)))) await writeLayout(manifest.dir, canvas);
  return canvas;
}

export async function updatePositions(dir: string, positions: Record<string, { x: number; y: number }>): Promise<void> {
  const c = await readLayout(dir);
  if (!c) return;
  for (const n of c.nodes) {
    const p = positions[n.id];
    if (p) {
      n.x = Math.round(p.x);
      n.y = Math.round(p.y);
    }
  }
  await writeLayout(dir, c);
}
