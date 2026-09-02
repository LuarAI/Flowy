/** Types mirrored from the server (kept loose on purpose) and fetch helpers. */

export interface NodeAddr {
  node: string;
  item?: { foreach: string; id: string };
}

export interface NodeResult {
  status: string;
  version: string;
  started: string;
  ended: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  tokens: { input: number; output: number; cache_read: number } | null;
  session_id: string | null;
  outputs: Record<string, { bytes: number; sha256: string }>;
  error: string | null;
  engine: string | null;
  mode: string;
}

export interface NodeView {
  addr: NodeAddr;
  id: string;
  title: string;
  mode: "agent" | "script" | "wait" | "chat";
  engine: string;
  status: string;
  version: string | null;
  versions: string[];
  result: NodeResult | null;
  approval: Record<string, unknown> | null;
  gate: boolean;
  staleReasons: string[];
  hint: string | null;
  lock: string | null;
  needs: string[];
  outputs: string[];
  approveFields: Record<string, { type: string; required?: boolean; description?: string }> | null;
  recipe: boolean;
  continues: string | null;
}

export interface ItemView {
  id: string;
  state: string;
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

export interface Overview {
  run: { id: string; workflow: string; status: string; started: string; inputs: Record<string, unknown> };
  nodes: NodeView[];
  foreach: ForeachView[];
  totals: { cost_usd: number; duration_ms: number; done: number; total: number };
  pending: Array<{ addr: NodeAddr; status: string; hint: string | null }>;
}

export interface Manifest {
  name: string;
  description: string;
  inputs: Record<string, { type: string; required?: boolean; default?: unknown; description?: string }>;
  nodes: Record<string, { id: string; mode: string; needs: string[]; approve: unknown; lock: string | null; foreach: string | null; outputs: string[]; title: string; context?: string[]; recipe?: boolean; continues?: string | null }>;
  foreach: Record<string, { id: string; source: { node: string; key: string }; nodes: string[]; needs: string[] }>;
  top: string[];
  edges: Array<{ from: string; to: string }>;
  concurrency: number;
}

export interface Canvas {
  nodes: Array<{ id: string; x: number; y: number; width: number; height: number; text?: string }>;
  edges: Array<{ id: string; fromNode: string; toNode: string }>;
}

export interface State {
  dir: string;
  manifest: Manifest | null;
  liveManifestDiffers: boolean;
  compileError: string | null;
  layout: Canvas | null;
  runs: string[];
  overview: Overview | null;
  running: string | null;
  undo: number;
  logs: string[];
}

export interface TraceEvent {
  t: string;
  type: string;
  engine: string;
  payload: unknown;
}

export interface NodeDetail {
  view: NodeView;
  versionDir: string | null;
  prompt: string | null;
  feedback: string | null;
  outputs: Array<{ path: string; bytes: number; text: string | null }>;
  inputs: string[];
  versions: Array<{ name: string; result: NodeResult | null; approval: Record<string, unknown> | null; current: boolean }>;
  trace: TraceEvent[];
  stderr: string | null;
}

export async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export async function post<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export function addrParams(a: NodeAddr): Record<string, string | undefined> {
  return { node: a.node, item: a.item ? `${a.item.foreach}/${a.item.id}` : undefined };
}

export function addrKey(a: NodeAddr): string {
  return a.item ? `${a.item.foreach}/${a.item.id}:${a.node}` : a.node;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtCost(n: number | null | undefined): string {
  return n ? `$${n.toFixed(n < 0.01 ? 4 : 3)}` : "";
}

export function fmtDuration(ms: number | null | undefined): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const STATUS_COLORS: Record<string, string> = {
  pending: "var(--c-muted)",
  ready: "var(--c-muted)",
  running: "var(--c-blue)",
  gate: "var(--c-amber)",
  waiting: "var(--c-amber)",
  done: "var(--c-green)",
  cached: "var(--c-green)",
  stale: "var(--c-violet)",
  failed: "var(--c-red)",
  blocked: "var(--c-red)",
  missing_output: "var(--c-red)",
  schema_invalid: "var(--c-red)",
  timeout: "var(--c-red)",
  interrupted: "var(--c-red)",
  skipped: "var(--c-muted)",
  orphaned: "var(--c-muted)",
};
