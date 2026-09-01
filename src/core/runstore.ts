import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import { ensureDir, exists, isDir, nowIso, readJsonOrNull, readText, writeJson, writeText } from "./fsutil.js";
import type { Approval, ItemState, Manifest, NodeAddr, NodeResult, RunInfo } from "./types.js";
import type { Signature } from "./signature.js";

/** Everything about one run on disk (SPEC §6.1). */
export class RunStore {
  constructor(
    public run: RunInfo,
    public manifest: Manifest,
  ) {}

  get runsDir(): string {
    return path.dirname(this.run.dir);
  }

  // ---- addressing -------------------------------------------------------

  nodeDir(addr: NodeAddr): string {
    if (addr.item) return path.join(this.itemDir(addr.item.foreach, addr.item.id), "nodes", addr.node);
    return path.join(this.run.dir, "nodes", addr.node);
  }

  itemDir(foreach: string, id: string): string {
    return path.join(this.run.dir, "items", foreach, id);
  }

  // ---- versions ---------------------------------------------------------

  async versions(addr: NodeAddr): Promise<string[]> {
    const dir = this.nodeDir(addr);
    if (!(await isDir(dir))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && /^v\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
  }

  async current(addr: NodeAddr): Promise<string | null> {
    const f = path.join(this.nodeDir(addr), "current");
    if (!(await exists(f))) return null;
    const v = (await readText(f)).trim();
    return v || null;
  }

  async currentDir(addr: NodeAddr): Promise<string | null> {
    const v = await this.current(addr);
    return v ? path.join(this.nodeDir(addr), v) : null;
  }

  async setCurrent(addr: NodeAddr, version: string): Promise<void> {
    await writeText(path.join(this.nodeDir(addr), "current"), version + "\n");
  }

  async newVersion(addr: NodeAddr): Promise<{ name: string; dir: string }> {
    const vs = await this.versions(addr);
    const last = vs.length ? parseInt(vs[vs.length - 1].slice(1)) : 0;
    const name = `v${last + 1}`;
    const dir = path.join(this.nodeDir(addr), name);
    await ensureDir(path.join(dir, "in"));
    await ensureDir(path.join(dir, "out"));
    return { name, dir };
  }

  versionDir(addr: NodeAddr, version: string): string {
    return path.join(this.nodeDir(addr), version);
  }

  // ---- per-version files ------------------------------------------------

  async readResult(versionDir: string): Promise<NodeResult | null> {
    return readJsonOrNull<NodeResult>(path.join(versionDir, "result.json"));
  }

  async writeResult(versionDir: string, r: NodeResult): Promise<void> {
    await writeJson(path.join(versionDir, "result.json"), r);
  }

  async readSignature(versionDir: string): Promise<Signature | null> {
    return readJsonOrNull<Signature>(path.join(versionDir, "signature.json"));
  }

  async writeSignature(versionDir: string, s: Signature): Promise<void> {
    await writeJson(path.join(versionDir, "signature.json"), s);
  }

  async readApproval(versionDir: string): Promise<Approval | null> {
    const f = path.join(versionDir, "approval.yaml");
    if (!(await exists(f))) return null;
    try {
      const v = YAML.parse(await readText(f));
      return v && typeof v === "object" ? (v as Approval) : null;
    } catch {
      return null;
    }
  }

  async writeApproval(versionDir: string, fields: Record<string, unknown>, by = "local"): Promise<Approval> {
    const a: Approval = { ...fields, _approved_at: nowIso(), _approved_by: by };
    await writeText(path.join(versionDir, "approval.yaml"), YAML.stringify(a));
    return a;
  }

  // ---- items ------------------------------------------------------------

  async listItems(foreach: string): Promise<Array<{ id: string; state: ItemState; item: Record<string, unknown> | null }>> {
    const dir = path.join(this.run.dir, "items", foreach);
    if (!(await isDir(dir))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const state = ((await readText(path.join(dir, e.name, "status")).catch(() => "pending")).trim() || "pending") as ItemState;
      const item = await readJsonOrNull<Record<string, unknown>>(path.join(dir, e.name, "item.json"));
      out.push({ id: e.name, state, item });
    }
    return out.sort((a, b) => {
      const ia = Number((a.item as { _index?: number } | null)?._index ?? 0);
      const ib = Number((b.item as { _index?: number } | null)?._index ?? 0);
      return ia - ib || (a.id < b.id ? -1 : 1);
    });
  }

  async itemState(foreach: string, id: string): Promise<ItemState> {
    const f = path.join(this.itemDir(foreach, id), "status");
    return ((await readText(f).catch(() => "pending")).trim() || "pending") as ItemState;
  }

  async setItemState(foreach: string, id: string, state: ItemState): Promise<void> {
    await writeText(path.join(this.itemDir(foreach, id), "status"), state + "\n");
  }

  async ensureItem(foreach: string, id: string, item: Record<string, unknown>): Promise<boolean> {
    const dir = this.itemDir(foreach, id);
    const isNew = !(await exists(path.join(dir, "item.json")));
    await ensureDir(dir);
    await writeJson(path.join(dir, "item.json"), item);
    if (isNew) await this.setItemState(foreach, id, "pending");
    return isNew;
  }

  // ---- run.yaml ---------------------------------------------------------

  async save(): Promise<void> {
    await writeText(path.join(this.run.dir, "run.yaml"), YAML.stringify(this.run));
  }

  async setStatus(status: RunInfo["status"]): Promise<void> {
    this.run.status = status;
    await this.save();
  }
}

/** Resolve and validate run inputs against the manifest (SPEC §1.1). */
export function resolveInputs(manifest: Manifest, given: Record<string, unknown>, cwd = process.cwd()): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [name, decl] of Object.entries(manifest.inputs)) {
    let v = given[name];
    if (v === undefined || v === null || v === "") v = decl.default;
    if (v === undefined || v === null) {
      if (decl.required) errors.push(`missing required input "${name}"`);
      out[name] = null;
      continue;
    }
    switch (decl.type) {
      case "string":
        out[name] = String(v);
        break;
      case "number": {
        const n = Number(v);
        if (Number.isNaN(n)) errors.push(`input "${name}" must be a number`);
        out[name] = n;
        break;
      }
      case "boolean":
        out[name] = v === true || v === "true" || v === "1" || v === 1;
        break;
      case "path":
        out[name] = path.resolve(cwd, String(v));
        break;
      case "list":
        out[name] = Array.isArray(v) ? v : String(v).split(",").map((s) => s.trim()).filter(Boolean);
        break;
    }
  }
  for (const k of Object.keys(given)) if (!(k in manifest.inputs)) errors.push(`unknown input "${k}"`);
  if (errors.length) throw new Error(errors.join("; "));
  return out;
}

export function newRunId(): string {
  const d = new Date();
  const date = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${date}_${randomBytes(3).toString("hex")}`;
}

export async function createRun(manifest: Manifest, inputs: Record<string, unknown>, runId?: string): Promise<RunStore> {
  const runsDir = path.join(manifest.dir, "runs");
  const id = runId ?? newRunId();
  const dir = path.join(runsDir, id);
  if (await exists(dir)) throw new Error(`run "${id}" already exists`);
  await ensureDir(dir);
  const run: RunInfo = {
    id,
    workflow: manifest.name,
    workflowDir: manifest.dir,
    dir,
    started: nowIso(),
    seed: randomBytes(4).readUInt32BE(0),
    inputs,
    status: "idle",
  };
  const store = new RunStore(run, manifest);
  await store.save();
  await writeJson(path.join(dir, "manifest.json"), manifest);
  return store;
}

export async function listRuns(workflowDir: string): Promise<string[]> {
  const runsDir = path.join(workflowDir, "runs");
  if (!(await isDir(runsDir))) return [];
  const entries = await fs.readdir(runsDir, { withFileTypes: true });
  const withTime: Array<{ id: string; t: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = path.join(runsDir, e.name, "run.yaml");
    if (!(await exists(f))) continue;
    withTime.push({ id: e.name, t: (await fs.stat(f)).mtimeMs });
  }
  return withTime.sort((a, b) => b.t - a.t).map((x) => x.id);
}

/** Load a run by id, or the most recent one. */
export async function loadRun(workflowDir: string, runId?: string): Promise<RunStore | null> {
  const ids = await listRuns(workflowDir);
  const id = runId ?? ids[0];
  if (!id) return null;
  const dir = path.join(workflowDir, "runs", id);
  const runFile = path.join(dir, "run.yaml");
  if (!(await exists(runFile))) return null;
  const run = YAML.parse(await readText(runFile)) as RunInfo;
  run.dir = dir; // in case the folder moved
  const manifest = await readJsonOrNull<Manifest>(path.join(dir, "manifest.json"));
  if (!manifest) return null;
  return new RunStore(run, manifest);
}

export function parseAddr(node: string, item?: string): NodeAddr {
  if (!item) return { node };
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(item);
  if (!m) throw new Error(`--item must look like <foreach>/<item-id> (got "${item}")`);
  return { node, item: { foreach: m[1], id: m[2] } };
}

export function addrKey(a: NodeAddr): string {
  return a.item ? `${a.item.foreach}/${a.item.id}:${a.node}` : a.node;
}
