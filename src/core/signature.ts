import path from "node:path";
import { sha256 } from "./fsutil.js";

/**
 * Cache signature (SPEC §6.3). The parts are recorded in signature.json so a
 * mismatch can be explained ("context/voice.md changed").
 */
export interface SignatureParts {
  node: string; // hash of resolved node file (frontmatter + resolved body)
  engine: string; // hash of engine config affecting output
  context: Record<string, string>; // rel path -> hash
  inputs: Record<string, string>; // in/<upstream>/<file> -> hash (upstream current outputs + approvals)
  item: string; // hash of item object or ""
  scripts: Record<string, string>; // referenced script files -> hash
}

export interface Signature {
  hash: string;
  parts: SignatureParts;
}

export function finalizeSignature(parts: SignatureParts): Signature {
  const canonical = JSON.stringify({
    node: parts.node,
    engine: parts.engine,
    context: sortObj(parts.context),
    inputs: sortObj(parts.inputs),
    item: parts.item,
    scripts: sortObj(parts.scripts),
  });
  return { hash: sha256(canonical), parts };
}

function sortObj(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Human-readable diff between two signatures, for the viewer and `flowy status`. */
export function explainSignatureDiff(a: Signature | null, b: Signature): string[] {
  if (!a) return ["no previous version"];
  const reasons: string[] = [];
  if (a.parts.node !== b.parts.node) reasons.push("node file changed");
  if (a.parts.engine !== b.parts.engine) reasons.push("engine config changed");
  if (a.parts.item !== b.parts.item) reasons.push("item changed");
  for (const [k, group] of [
    ["context", "context"],
    ["inputs", "input"],
    ["scripts", "script"],
  ] as const) {
    const pa = a.parts[k];
    const pb = b.parts[k];
    for (const f of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
      if (pa[f] !== pb[f]) reasons.push(`${group} ${f} ${pa[f] ? (pb[f] ? "changed" : "removed") : "added"}`);
    }
  }
  return reasons;
}

/** Best-effort: any whitespace-separated token in `cmd` that names an existing file under `scriptsDir`. */
export function scriptTokens(cmd: string, scriptsDir: string): string[] {
  const tokens = cmd.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  const out: string[] = [];
  for (const t of tokens) {
    if (!t) continue;
    const abs = path.isAbsolute(t) ? t : path.resolve(scriptsDir, "..", t);
    if (abs.startsWith(scriptsDir)) out.push(abs);
  }
  return out;
}
