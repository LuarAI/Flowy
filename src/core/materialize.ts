import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, exists, hashFile, isDir, listFiles, readJsonOrNull, sha256, toPosix, writeJson, writeText } from "./fsutil.js";
import type { RunStore } from "./runstore.js";
import { resolveTemplate, type TemplateContext } from "./template.js";
import type { NodeAddr, NodeSpec } from "./types.js";

/** One file that will appear under in/. */
export interface InputSource {
  /** POSIX path relative to in/ */
  rel: string;
  /** Absolute source path, or null when the content is generated (`content`). */
  abs: string | null;
  content?: string;
  /** Part of the cache signature? (previous outputs and feedback are not.) */
  signed: boolean;
  group: "context" | "input" | "generated";
}

export class InputsNotReady extends Error {}

/** Layout rule for context entries (SPEC §4). */
export function contextTargetPath(entry: string, resolved: string, wfDir: string): string {
  if (entry.includes("{{") || path.isAbsolute(entry)) return path.basename(resolved);
  let rel = toPosix(path.relative(wfDir, resolved));
  rel = rel.replace(/^(\.\.\/)+/, "").replace(/^context\//, "");
  return rel;
}

/**
 * Enumerate every file the node will see under in/ (SPEC §4), without copying.
 * Throws InputsNotReady when an upstream node has no current version.
 */
export async function collectInputSources(store: RunStore, spec: NodeSpec, addr: NodeAddr, tctx: TemplateContext): Promise<InputSource[]> {
  const m = store.manifest;
  const out: InputSource[] = [];

  // context
  for (const entry of spec.context) {
    const resolvedEntry = resolveTemplate(entry, tctx);
    const abs = path.isAbsolute(resolvedEntry) ? resolvedEntry : path.resolve(spec.workflowDir, resolvedEntry);
    const target = contextTargetPath(entry, abs, spec.workflowDir);
    if (await isDir(abs)) {
      for (const f of await listFiles(abs)) out.push({ rel: `context/${target}/${f}`, abs: path.join(abs, f), signed: true, group: "context" });
    } else if (await exists(abs)) {
      out.push({ rel: `context/${target}`, abs, signed: true, group: "context" });
    } else {
      throw new Error(`context path not found: ${entry} (${abs})`);
    }
  }
  const seen = new Set<string>();
  for (const s of out) {
    if (seen.has(s.rel)) throw new Error(`two context entries resolve to in/${s.rel}`);
    seen.add(s.rel);
  }

  // upstream
  for (const dep of spec.needs) {
    if (dep in m.foreach) {
      const fe = m.foreach[dep];
      for (const it of await store.listItems(dep)) {
        if (it.state !== "done" && it.state !== "skipped") continue;
        out.push({ rel: `${dep}/${it.id}/status`, abs: null, content: it.state + "\n", signed: true, group: "input" });
        out.push({ rel: `${dep}/${it.id}/item.json`, abs: path.join(store.itemDir(dep, it.id), "item.json"), signed: true, group: "input" });
        if (it.state === "skipped") continue;
        for (const nid of fe.nodes) {
          const vdir = await store.currentDir({ node: nid, item: { foreach: dep, id: it.id } });
          if (!vdir) continue;
          await pushOutputs(out, vdir, `${dep}/${it.id}/${nid}`);
        }
      }
    } else {
      const depSpec = m.nodes[dep];
      const depAddr: NodeAddr = depSpec.foreach && addr.item ? { node: dep, item: addr.item } : { node: dep };
      const vdir = await store.currentDir(depAddr);
      if (!vdir) throw new InputsNotReady(`upstream "${dep}" has no current version`);
      await pushOutputs(out, vdir, dep);
    }
  }
  return out;
}

async function pushOutputs(out: InputSource[], vdir: string, prefix: string) {
  const od = path.join(vdir, "out");
  for (const f of await listFiles(od)) out.push({ rel: `${prefix}/${f}`, abs: path.join(od, f), signed: true, group: "input" });
  const ap = path.join(vdir, "approval.yaml");
  if (await exists(ap)) out.push({ rel: `${prefix}/approval.yaml`, abs: ap, signed: true, group: "input" });
}

export interface MaterializeResult {
  addDirs: string[];
  refs: Array<{ rel: string; path: string; bytes: number }>;
  hashes: { context: Record<string, string>; inputs: Record<string, string> };
}

/** Build in/ for a version directory (SPEC §4, §4.2). */
export async function materialize(
  store: RunStore,
  spec: NodeSpec,
  addr: NodeAddr,
  versionDir: string,
  tctx: TemplateContext,
  sources: InputSource[],
  opts: { previousOutDir?: string | null; item?: Record<string, unknown> | null } = {},
): Promise<MaterializeResult> {
  const inDir = path.join(versionDir, "in");
  await ensureDir(inDir);
  const threshold = store.manifest.link_threshold;
  const addDirs = new Set<string>();
  const refs: MaterializeResult["refs"] = [];
  const hashes = { context: {} as Record<string, string>, inputs: {} as Record<string, string> };

  await writeJson(path.join(inDir, "_inputs.json"), {
    inputs: tctx.inputs,
    item: opts.item ?? null,
    run: tctx.run,
    node: addr,
  });

  for (const s of sources) {
    const dest = path.join(inDir, s.rel);
    if (s.abs === null) {
      await writeText(dest, s.content ?? "");
      if (s.signed) hashes.inputs[s.rel] = sha(s.content ?? "");
      continue;
    }
    const st = await fs.stat(s.abs);
    if (st.size > threshold) {
      // Large: try a hard link, else reference.
      await ensureDir(path.dirname(dest));
      try {
        await fs.link(s.abs, dest);
      } catch {
        refs.push({ rel: s.rel, path: s.abs, bytes: st.size });
        addDirs.add(path.dirname(s.abs));
      }
      // Large files are signed by size+mtime rather than content, to keep signatures cheap.
      if (s.signed) (s.group === "context" ? hashes.context : hashes.inputs)[s.rel] = `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}`;
    } else {
      await ensureDir(path.dirname(dest));
      try {
        await fs.link(s.abs, dest);
      } catch {
        await fs.copyFile(s.abs, dest);
      }
      if (s.signed) (s.group === "context" ? hashes.context : hashes.inputs)[s.rel] = await hashFile(s.abs);
    }
  }

  if (refs.length) await writeJson(path.join(inDir, "_refs.json"), refs);

  if (opts.previousOutDir && (await isDir(opts.previousOutDir))) {
    for (const f of await listFiles(opts.previousOutDir)) {
      const dest = path.join(inDir, "_previous", f);
      await ensureDir(path.dirname(dest));
      await fs.copyFile(path.join(opts.previousOutDir, f), dest);
    }
  }

  return { addDirs: [...addDirs], refs, hashes };
}

/** Hash the sources without materializing — used for stale detection. */
export async function hashSources(sources: InputSource[], threshold: number): Promise<{ context: Record<string, string>; inputs: Record<string, string> }> {
  const hashes = { context: {} as Record<string, string>, inputs: {} as Record<string, string> };
  for (const s of sources) {
    if (!s.signed) continue;
    const bucket = s.group === "context" ? hashes.context : hashes.inputs;
    if (s.abs === null) {
      bucket[s.rel] = sha(s.content ?? "");
      continue;
    }
    const st = await fs.stat(s.abs);
    bucket[s.rel] = st.size > threshold ? `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}` : await hashFile(s.abs);
  }
  return hashes;
}

function sha(s: string): string {
  return sha256(s);
}

export async function readItem(store: RunStore, addr: NodeAddr): Promise<Record<string, unknown> | null> {
  if (!addr.item) return null;
  return readJsonOrNull<Record<string, unknown>>(path.join(store.itemDir(addr.item.foreach, addr.item.id), "item.json"));
}
