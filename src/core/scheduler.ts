import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineRegistry } from "../engines/index.js";
import { ancestorsOf } from "./compile.js";
import { exists, readJsonOrNull, writeText } from "./fsutil.js";
import { executeNode, settleWaiting, addrLabel, type ExecEvent } from "./execute.js";
import type { RunStore } from "./runstore.js";
import { nodeView, type NodeView } from "./status.js";
import type { ItemState, NodeAddr, NodeStatus } from "./types.js";

export interface RunOptions {
  engines: EngineRegistry;
  signal: AbortSignal;
  until?: string;
  log?: (msg: string) => void;
  emit?: (e: ExecEvent | { type: "run"; status: string; message?: string }) => void;
  env?: NodeJS.ProcessEnv;
  /** Poll interval while things are running (ms). */
  tick?: number;
}

export interface RunSummary {
  status: "done" | "idle" | "failed" | "interrupted";
  ran: string[];
  cached: string[];
  failed: string[];
  pending: Array<{ addr: NodeAddr; status: NodeStatus; hint: string | null }>;
}

const SATISFIED: NodeStatus[] = ["done"];
const TERMINAL_ITEM: ItemState[] = ["done", "skipped", "orphaned"];

/**
 * Drive a run until nothing more can proceed without a human (SPEC §7).
 * Exits when every runnable node has run; gates and waits stay pending on disk.
 */
export async function runWorkflow(store: RunStore, opts: RunOptions): Promise<RunSummary> {
  const m = store.manifest;
  const log = opts.log ?? (() => {});
  const emit = opts.emit ?? (() => {});
  const tick = opts.tick ?? 500;
  const ctx = { store, engines: opts.engines, signal: opts.signal, log, emit, env: opts.env };

  await acquireRunLock(store);
  await store.setStatus("running");
  emit({ type: "run", status: "running" });

  const summary: RunSummary = { status: "idle", ran: [], cached: [], failed: [], pending: [] };
  const attempted = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const lockHeld = new Map<string, number>();
  let lastAgentStart = 0;

  // --until scope
  let scope: Set<string> | null = null;
  if (opts.until) {
    if (!(opts.until in m.nodes) && !(opts.until in m.foreach)) throw new Error(`--until: unknown node "${opts.until}"`);
    if (m.nodes[opts.until]?.foreach) throw new Error(`--until must name a top-level node or a foreach id`);
    scope = ancestorsOf(m, opts.until);
    scope.add(opts.until);
  }
  const inScope = (top: string) => !scope || scope.has(top);

  try {
    for (;;) {
      if (opts.signal.aborted) break;
      await expandForeaches(store, ctx, log);
      await settleAll(store, ctx);

      const ready = await collectReady(store, attempted, running, inScope);
      let started = 0;
      const capacity = () => m.concurrency - running.size;

      for (const r of ready) {
        if (capacity() <= 0) break;
        const spec = m.nodes[r.addr.node];
        if (spec.lock) {
          const max = m.locks[spec.lock] ?? 1;
          if ((lockHeld.get(spec.lock) ?? 0) >= max) continue;
        }
        if (r.addr.item) {
          const fe = m.foreach[r.addr.item.foreach];
          const active = [...running.keys()].filter((k) => k.startsWith(`${fe.id}/`)).length;
          if (active >= fe.concurrency) continue;
        }
        if (spec.mode === "agent") {
          const since = Date.now() - lastAgentStart;
          if (lastAgentStart && since < m.stagger_ms && running.size > 0) continue;
          lastAgentStart = Date.now();
        }
        const key = addrLabel(r.addr);
        attempted.add(key);
        if (spec.lock) lockHeld.set(spec.lock, (lockHeld.get(spec.lock) ?? 0) + 1);
        if (r.addr.item) await store.setItemState(r.addr.item.foreach, r.addr.item.id, "running");
        log(`▶ ${key}${r.reason ? ` (${r.reason})` : ""}`);
        const p = executeNode(ctx, r.addr)
          .then((o) => {
            if (o.kind === "cached") {
              summary.cached.push(key);
              log(`= ${key} cached (${o.version})`);
            } else {
              const st = o.result.status;
              if (st === "done") summary.ran.push(key);
              else if (st === "waiting") log(`… ${key} waiting for ${spec.mode === "chat" ? "`flowy chat`" : "files"}: ${spec.outputs.join(", ")}`);
              else {
                summary.failed.push(key);
                log(`✗ ${key} ${st}${o.result.error ? `: ${o.result.error.split("\n")[0]}` : ""}`);
              }
              if (st === "done") log(`✓ ${key} (${o.version}${o.result.cost_usd ? `, $${o.result.cost_usd.toFixed(3)}` : ""})`);
            }
          })
          .catch((e) => {
            summary.failed.push(key);
            log(`✗ ${key} ${e instanceof Error ? e.message : String(e)}`);
          })
          .finally(() => {
            running.delete(key);
            if (spec.lock) lockHeld.set(spec.lock, (lockHeld.get(spec.lock) ?? 1) - 1);
          });
        running.set(key, p);
        started++;
      }

      if (running.size === 0 && started === 0) {
        // Nothing runnable. Are we waiting on a stagger/lock only?
        const blockedByStagger = ready.some((r) => m.nodes[r.addr.node].mode === "agent");
        if (blockedByStagger && ready.length) {
          await sleep(Math.min(tick, m.stagger_ms));
          continue;
        }
        break;
      }
      await Promise.race([...running.values(), sleep(tick)]);
    }
  } finally {
    await Promise.allSettled([...running.values()]);
    await releaseRunLock(store);
  }

  await settleAll(store, ctx);
  await updateItemStates(store);
  const pending = await pendingHuman(store);
  summary.pending = pending;
  // Nodes that were already done and untouched this run count as cached.
  for (const id of m.top) {
    if (!inScope(id)) continue;
    if (id in m.foreach) {
      for (const it of await store.listItems(id)) {
        if (it.state === "skipped" || it.state === "orphaned") continue;
        for (const nid of m.foreach[id].nodes) {
          const key = addrLabel({ node: nid, item: { foreach: id, id: it.id } });
          if (!attempted.has(key) && (await nodeView(store, { node: nid, item: { foreach: id, id: it.id } }, { checkStale: false })).status === "done") summary.cached.push(key);
        }
      }
    } else if (!attempted.has(id) && (await nodeView(store, { node: id }, { checkStale: false })).status === "done") summary.cached.push(id);
  }
  if (opts.signal.aborted) summary.status = "interrupted";
  else if (summary.failed.length) summary.status = "failed";
  else if (pending.length || !(await allDone(store, inScope))) summary.status = "idle";
  else summary.status = "done";
  await store.setStatus(summary.status === "interrupted" ? "idle" : summary.status);
  emit({ type: "run", status: summary.status });
  return summary;
}

interface Ready {
  addr: NodeAddr;
  reason?: string;
}

async function collectReady(store: RunStore, attempted: Set<string>, running: Map<string, Promise<void>>, inScope: (top: string) => boolean): Promise<Ready[]> {
  const m = store.manifest;
  const out: Ready[] = [];
  const views = new Map<string, NodeView>();
  const view = async (addr: NodeAddr) => {
    const k = addrLabel(addr);
    if (!views.has(k)) views.set(k, await nodeView(store, addr));
    return views.get(k)!;
  };

  const depOk = async (dep: string, item: NodeAddr["item"] | undefined): Promise<boolean> => {
    if (dep in m.foreach) return foreachDone(store, dep);
    const spec = m.nodes[dep];
    const addr: NodeAddr = spec.foreach && item ? { node: dep, item } : { node: dep };
    const v = await view(addr);
    if (!SATISFIED.includes(v.status)) return false;
    return !(v.gate && !v.approval);
  };

  const consider = async (addr: NodeAddr) => {
    const key = addrLabel(addr);
    if (running.has(key) || attempted.has(key)) return;
    const spec = m.nodes[addr.node];
    const v = await view(addr);
    const runnable: NodeStatus[] = ["pending", "stale", "failed", "blocked", "missing_output", "schema_invalid", "timeout", "interrupted"];
    if (!runnable.includes(v.status)) return;
    for (const dep of spec.needs) if (!(await depOk(dep, addr.item))) return;
    if (addr.item) for (const dep of m.foreach[addr.item.foreach].needs) if (!(await depOk(dep, undefined))) return;
    out.push({ addr, reason: v.status === "stale" ? `stale: ${v.staleReasons.slice(0, 2).join(", ")}` : v.status !== "pending" ? `retry after ${v.status}` : undefined });
  };

  for (const id of m.top) {
    if (!inScope(id)) continue;
    if (id in m.foreach) {
      const fe = m.foreach[id];
      for (const it of await store.listItems(id)) {
        if (it.state === "skipped" || it.state === "orphaned") continue;
        for (const nid of fe.nodes) await consider({ node: nid, item: { foreach: id, id: it.id } });
      }
    } else await consider({ node: id });
  }
  return out;
}

async function foreachDone(store: RunStore, feId: string): Promise<boolean> {
  const fe = store.manifest.foreach[feId];
  const items = await store.listItems(feId);
  if (!items.length) {
    // Expanded with zero items counts as done only if the source has run and been approved.
    const src = await nodeView(store, { node: fe.source.node });
    return src.status === "done" && !(src.gate && !src.approval) && (await exists(path.join(store.run.dir, "items", feId, ".expanded")));
  }
  for (const it of items) {
    if (it.state === "skipped" || it.state === "orphaned") continue;
    for (const nid of fe.nodes) {
      const v = await nodeView(store, { node: nid, item: { foreach: feId, id: it.id } });
      if (v.status !== "done" || (v.gate && !v.approval)) return false;
    }
  }
  return true;
}

/** Create items from the source node's array once the source is done and approved (SPEC §5). */
async function expandForeaches(store: RunStore, ctx: Parameters<typeof executeNode>[0], log: (m: string) => void): Promise<void> {
  const m = store.manifest;
  for (const fe of Object.values(m.foreach)) {
    const src = await nodeView(store, { node: fe.source.node });
    if (src.status !== "done" || (src.gate && !src.approval)) continue;
    const vdir = await store.currentDir({ node: fe.source.node });
    if (!vdir) continue;
    const array = await readSourceArray(vdir, fe.source.key);
    if (!array) {
      log(`foreach ${fe.id}: source ${fe.source.node}.${fe.source.key} is not an array`);
      continue;
    }
    const marker = path.join(store.run.dir, "items", fe.id, ".expanded");
    const previous = (await readJsonOrNull<{ hash: string }>(marker))?.hash;
    const hash = JSON.stringify(array);
    if (previous === hash) continue;
    const ids = new Set<string>();
    for (let i = 0; i < array.length; i++) {
      const el = array[i];
      const obj: Record<string, unknown> = el && typeof el === "object" && !Array.isArray(el) ? { ...(el as Record<string, unknown>) } : { value: el };
      const rawId = fe.key && obj[fe.key] !== undefined ? String(obj[fe.key]) : String(i + 1).padStart(3, "0");
      let id = slug(rawId);
      while (ids.has(id)) id = `${id}-${i + 1}`;
      ids.add(id);
      obj._index = i;
      await store.ensureItem(fe.id, id, obj);
    }
    for (const it of await store.listItems(fe.id)) {
      if (!ids.has(it.id) && it.state !== "skipped" && it.state !== "orphaned") {
        await store.setItemState(fe.id, it.id, "orphaned");
        log(`foreach ${fe.id}: item ${it.id} orphaned (no longer in source)`);
      } else if (ids.has(it.id) && it.state === "orphaned") {
        await store.setItemState(fe.id, it.id, "pending");
      }
    }
    await writeText(marker, JSON.stringify({ hash }));
    ctx.emit({ type: "node", addr: { node: fe.id }, status: "done", message: `expanded ${ids.size} items` });
    log(`foreach ${fe.id}: ${ids.size} item${ids.size === 1 ? "" : "s"}`);
  }
}

async function readSourceArray(vdir: string, key: string): Promise<unknown[] | null> {
  const structured = await readJsonOrNull<Record<string, unknown>>(path.join(vdir, "out", "structured.json"));
  if (structured && Array.isArray(structured[key])) return structured[key] as unknown[];
  const named = await readJsonOrNull<unknown>(path.join(vdir, "out", `${key}.json`));
  if (Array.isArray(named)) return named;
  if (named && typeof named === "object" && Array.isArray((named as Record<string, unknown>)[key])) return (named as Record<string, unknown>)[key] as unknown[];
  return null;
}

async function settleAll(store: RunStore, ctx: Parameters<typeof settleWaiting>[0]): Promise<void> {
  const m = store.manifest;
  for (const id of m.top) {
    if (id in m.foreach) {
      const fe = m.foreach[id];
      for (const it of await store.listItems(id)) {
        if (it.state === "skipped" || it.state === "orphaned") continue;
        for (const nid of fe.nodes) if (["wait", "chat"].includes(m.nodes[nid].mode)) await settleWaiting(ctx, { node: nid, item: { foreach: id, id: it.id } });
      }
    } else if (["wait", "chat"].includes(m.nodes[id].mode)) await settleWaiting(ctx, { node: id });
  }
}

/** Items become `done` when every nested node is done and approved. */
export async function updateItemStates(store: RunStore): Promise<void> {
  const m = store.manifest;
  for (const fe of Object.values(m.foreach)) {
    for (const it of await store.listItems(fe.id)) {
      if (it.state === "skipped" || it.state === "orphaned") continue;
      let all = true;
      let any = false;
      for (const nid of fe.nodes) {
        const v = await nodeView(store, { node: nid, item: { foreach: fe.id, id: it.id } }, { checkStale: false });
        if (v.version) any = true;
        if (v.status !== "done" || (v.gate && !v.approval)) all = false;
      }
      const next: ItemState = all ? "done" : any ? "running" : "pending";
      if (next !== it.state) await store.setItemState(fe.id, it.id, next);
    }
  }
}

async function pendingHuman(store: RunStore) {
  const m = store.manifest;
  const out: Array<{ addr: NodeAddr; status: NodeStatus; hint: string | null }> = [];
  const check = async (addr: NodeAddr) => {
    const v = await nodeView(store, addr, { checkStale: false });
    const openChat = v.mode === "chat" && m.nodes[addr.node].outputs.length === 0 && !v.recipe;
    if ((v.status === "gate" || v.status === "waiting") && !openChat) out.push({ addr, status: v.status, hint: v.hint });
  };
  for (const id of m.top) {
    if (id in m.foreach) {
      for (const it of await store.listItems(id)) {
        if (TERMINAL_ITEM.includes(it.state) && it.state !== "done") continue;
        for (const nid of m.foreach[id].nodes) await check({ node: nid, item: { foreach: id, id: it.id } });
      }
    } else await check({ node: id });
  }
  return out;
}

async function allDone(store: RunStore, inScope: (top: string) => boolean): Promise<boolean> {
  const m = store.manifest;
  for (const id of m.top) {
    if (!inScope(id)) continue;
    if (id in m.foreach) {
      if (!(await foreachDone(store, id))) return false;
    } else {
      const v = await nodeView(store, { node: id }, { checkStale: false });
      if (v.status !== "done" || (v.gate && !v.approval)) return false;
    }
  }
  return true;
}

function slug(s: string): string {
  const x = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return x || "item";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- run lock (one scheduler per run) ------------------------------------

async function acquireRunLock(store: RunStore): Promise<void> {
  const f = path.join(store.run.dir, ".lock");
  const existing = await readJsonOrNull<{ pid: number; at: string }>(f);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    throw new Error(`run ${store.run.id} is already being driven by pid ${existing.pid} (since ${existing.at})`);
  }
  await writeText(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
}

async function releaseRunLock(store: RunStore): Promise<void> {
  await fs.rm(path.join(store.run.dir, ".lock"), { force: true });
}

export async function runLockHolder(store: RunStore): Promise<number | null> {
  const existing = await readJsonOrNull<{ pid: number }>(path.join(store.run.dir, ".lock"));
  return existing && pidAlive(existing.pid) ? existing.pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
