import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { compileWorkflow } from "./compile.js";
import { exists, readText, writeText } from "./fsutil.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";

/**
 * Structural edits performed by the viewer (roadmap v3). Every edit rewrites
 * the authoring files, never the manifest; the result is validated by
 * recompiling. Frontmatter edits try a targeted text change first so the
 * author's formatting survives, and fall back to a full rewrite.
 */

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function nodeFileFor(dir: string, id: string): Promise<string> {
  const m = await compileWorkflow(dir);
  const spec = m.nodes[id];
  if (!spec) throw new Error(`unknown node "${id}"`);
  return spec.file;
}

/** Add `from` to the `needs:` of `to`. */
export async function addEdge(dir: string, from: string, to: string): Promise<void> {
  const file = await nodeFileFor(dir, to);
  await editNeeds(file, (needs) => (needs.includes(from) ? needs : [...needs, from]));
  await compileWorkflow(dir); // validate; throws CompileError with the reason
}

export async function removeEdge(dir: string, from: string, to: string): Promise<void> {
  const file = await nodeFileFor(dir, to);
  await editNeeds(file, (needs) => needs.filter((n) => n !== from));
  await compileWorkflow(dir);
}

/** Add a context entry to a node (drawing an arrow from a source pill to a step). */
export async function addContext(dir: string, nodeId: string, entry: string): Promise<void> {
  const file = await nodeFileFor(dir, nodeId);
  const fm = parseFrontmatter(await readText(file));
  const current = Array.isArray(fm.data.context) ? (fm.data.context as string[]) : [];
  if (!current.includes(entry)) fm.data.context = [...current, entry];
  await writeText(file, stringifyFrontmatter(fm.data, fm.body));
  await compileWorkflow(dir);
}

export async function removeContext(dir: string, nodeId: string, entry: string): Promise<void> {
  const file = await nodeFileFor(dir, nodeId);
  const fm = parseFrontmatter(await readText(file));
  const current = Array.isArray(fm.data.context) ? (fm.data.context as string[]) : [];
  const next = current.filter((c) => c !== entry);
  if (next.length) fm.data.context = next;
  else delete fm.data.context;
  await writeText(file, stringifyFrontmatter(fm.data, fm.body));
  await compileWorkflow(dir);
}

async function editNeeds(file: string, fn: (needs: string[]) => string[]): Promise<void> {
  const text = await readText(file);
  const fm = parseFrontmatter(text);
  const current = Array.isArray(fm.data.needs) ? (fm.data.needs as string[]) : [];
  const next = fn(current);
  const inline = `needs: [${next.join(", ")}]`;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex((l, i) => i > 0 && /^needs\s*:/.test(l));
  if (idx >= 0 && /^needs\s*:\s*\[.*\]\s*(#.*)?$/.test(lines[idx])) {
    lines[idx] = inline;
    await writeText(file, lines.join("\n"));
    return;
  }
  if (idx >= 0) {
    // block list: replace the block
    let end = idx + 1;
    while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
    lines.splice(idx, end - idx, inline);
    await writeText(file, lines.join("\n"));
    return;
  }
  if (next.length === 0) return;
  // insert after mode: (or after id:)
  const anchor = lines.findIndex((l, i) => i > 0 && /^(mode|id)\s*:/.test(l));
  if (anchor >= 0) {
    lines.splice(anchor + 1, 0, inline);
    await writeText(file, lines.join("\n"));
    return;
  }
  fm.data.needs = next;
  await writeText(file, stringifyFrontmatter(fm.data, fm.body));
}

export interface NewNode {
  id: string;
  mode: "agent" | "script" | "wait" | "chat";
  title?: string;
  needs?: string[];
  outputs?: string[];
  run?: string;
  body?: string;
}

/** Create nodes/<id>.md and append the id to workflow.yaml's nodes list. */
export async function addNode(dir: string, n: NewNode): Promise<string> {
  if (!ID_RE.test(n.id)) throw new Error(`invalid id "${n.id}"`);
  const file = path.join(dir, "nodes", `${n.id}.md`);
  if (await exists(file)) throw new Error(`nodes/${n.id}.md already exists`);
  const data: Record<string, unknown> = { id: n.id, title: n.title ?? n.id, mode: n.mode };
  if (n.needs?.length) data.needs = n.needs;
  data.outputs = n.outputs?.length ? n.outputs : [`${n.id}.md`];
  if (n.mode === "script") data.run = n.run ?? `echo TODO > "$env:FLOWY_OUT/${n.id}.md"`;
  if (n.mode === "wait") data.hint = `Drop ${data.outputs} into out/`;
  const body =
    n.body ??
    (n.mode === "agent" || n.mode === "chat"
      ? `Describe what this node does.\n\nRead the files under \`in/\` you need and write \`out/${(data.outputs as string[])[0]}\`.`
      : `Describe what this step produces.`);
  await writeText(file, stringifyFrontmatter(data, body));
  await appendToNodesList(path.join(dir, "workflow.yaml"), n.id);
  await compileWorkflow(dir);
  return file;
}

async function appendToNodesList(wfFile: string, id: string): Promise<void> {
  const text = (await readText(wfFile)).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^nodes\s*:/.test(l));
  if (idx < 0) {
    await writeText(wfFile, text.trimEnd() + `\n\nnodes:\n  - ${id}\n`);
    return;
  }
  let end = idx + 1;
  while (end < lines.length && (/^\s+/.test(lines[end]) || lines[end].trim() === "")) end++;
  // trim trailing blank lines inside the block
  let insertAt = end;
  while (insertAt > idx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, `  - ${id}`);
  await writeText(wfFile, lines.join("\n"));
}

/** Delete a top-level node file, its list entry, and every reference in other nodes' needs. */
export async function removeNode(dir: string, id: string): Promise<void> {
  const m = await compileWorkflow(dir);
  const spec = m.nodes[id];
  if (!spec) throw new Error(`unknown node "${id}"`);
  if (spec.foreach) throw new Error(`"${id}" is inside a foreach; edit the nested workflow directly`);
  for (const other of Object.values(m.nodes)) if (other.needs.includes(id)) await editNeeds(other.file, (n) => n.filter((x) => x !== id));
  const wfFile = path.join(dir, "workflow.yaml");
  const text = (await readText(wfFile)).replace(/\r\n/g, "\n");
  const lines = text.split("\n").filter((l) => !new RegExp(`^\\s+-\\s+${id}\\s*(#.*)?$`).test(l));
  await writeText(wfFile, lines.join("\n"));
  await fs.rm(spec.file, { force: true });
  await compileWorkflow(dir);
}

/** Replace a node's body (prompt) or a frontmatter field, keeping the rest. */
export async function updateNode(dir: string, id: string, patch: { body?: string; fields?: Record<string, unknown> }): Promise<void> {
  const file = await nodeFileFor(dir, id);
  const fm = parseFrontmatter(await readText(file));
  const data = { ...fm.data, ...(patch.fields ?? {}) };
  for (const [k, v] of Object.entries(patch.fields ?? {})) if (v === null) delete data[k];
  await writeText(file, stringifyFrontmatter(data, patch.body ?? fm.body));
  await compileWorkflow(dir);
}

export function yamlPreview(v: unknown): string {
  return YAML.stringify(v);
}
