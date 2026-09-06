import path from "node:path";
import YAML from "yaml";
import { exists, readText, writeText } from "./fsutil.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { RecipeSpec, RecipeStep } from "./types.js";

/**
 * Station recipes (SPEC §2.6): `recipes/<name>.md` is YAML frontmatter, a
 * preamble, and one `## Station` section per step. A line follows the
 * stations one at a time; the agent never sees the next one.
 */

const RECIPE_KEYS = new Set(["name", "title", "version", "context", "tools", "model", "permissions", "timeout", "styles"]);
const STEP_KEYS = new Set(["id", "gate", "expects", "model"]);
const GATES = ["auto", "confirm", "you"];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class RecipeError extends Error {}

export function slugify(s: string): string {
  const x = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return x || "station";
}

/** Parse a recipe file's text. `file` is only used for error messages and the spec. */
export function parseRecipe(text: string, file: string): RecipeSpec {
  const base = path.basename(file).replace(/\.md$/i, "");
  let fm;
  try {
    fm = parseFrontmatter(text);
  } catch (e) {
    throw new RecipeError(`${base}: ${(e as Error).message}`);
  }
  const d = fm.data;
  for (const k of Object.keys(d)) if (!RECIPE_KEYS.has(k)) throw new RecipeError(`${base}: unknown field "${k}" (recipes take ${[...RECIPE_KEYS].join(", ")})`);
  const name = typeof d.name === "string" && d.name ? d.name : base;
  if (!ID_RE.test(name)) throw new RecipeError(`${base}: name "${name}" must match ${ID_RE}`);
  const version = d.version === undefined || d.version === null ? 1 : Number(d.version);
  if (!Number.isInteger(version) || version < 1) throw new RecipeError(`${base}: version must be a positive integer`);
  const strList = (k: string): string[] | null => {
    const v = d[k];
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new RecipeError(`${base}: ${k} must be a list of strings`);
    return v as string[];
  };
  const styles: Record<string, string> = {};
  let defaultStyle: string | null = null;
  if (d.styles !== undefined && d.styles !== null) {
    if (typeof d.styles !== "object" || Array.isArray(d.styles)) throw new RecipeError(`${base}: styles must be a mapping of name -> description`);
    for (const [k, v] of Object.entries(d.styles as Record<string, unknown>)) {
      if (k === "default") {
        defaultStyle = String(v);
        continue;
      }
      if (!ID_RE.test(k)) throw new RecipeError(`${base}: style "${k}" must match ${ID_RE}`);
      styles[k] = String(v ?? "");
    }
    if (defaultStyle && !(defaultStyle in styles)) throw new RecipeError(`${base}: styles.default "${defaultStyle}" is not one of ${Object.keys(styles).join(", ") || "(none)"}`);
  }
  const permissions = d.permissions === undefined || d.permissions === null ? null : String(d.permissions);
  if (permissions && !["ask", "ask-all", "allow-all"].includes(permissions)) throw new RecipeError(`${base}: permissions must be "ask", "ask-all" or "allow-all"`);

  // Body: preamble, then `## ` sections.
  const lines = fm.body.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const steps: RecipeStep[] = [];
  let cur: { title: string; fields: Record<string, string>; body: string[]; inFields: boolean } | null = null;
  const flush = () => {
    if (!cur) return;
    const f = cur.fields;
    const id = f.id ?? slugify(cur.title);
    if (!ID_RE.test(id)) throw new RecipeError(`${base}: station "${cur.title}": id "${id}" must match ${ID_RE}`);
    if (steps.some((s) => s.id === id)) throw new RecipeError(`${base}: two stations share the id "${id}"`);
    const gate = f.gate ?? "confirm";
    if (!GATES.includes(gate)) throw new RecipeError(`${base}: station "${cur.title}": gate must be one of ${GATES.join(", ")}`);
    const expects = (f.expects ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const e of expects) if (path.isAbsolute(e) || e.startsWith("..")) throw new RecipeError(`${base}: station "${cur.title}": expects "${e}" must be relative to out/`);
    const body = cur.body.join("\n").trim();
    if (!body) throw new RecipeError(`${base}: station "${cur.title}" has no instruction`);
    steps.push({ id, title: cur.title, gate: gate as RecipeStep["gate"], expects, model: f.model ?? null, body });
    cur = null;
  };
  for (const raw of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      flush();
      cur = { title: h[1].replace(/^#+\s*/, ""), fields: {}, body: [], inFields: true };
      continue;
    }
    if (!cur) {
      preamble.push(raw);
      continue;
    }
    if (cur.inFields) {
      const kv = /^([a-z]+):\s*(.*)$/.exec(raw);
      if (kv) {
        if (!STEP_KEYS.has(kv[1])) throw new RecipeError(`${base}: station "${cur.title}": unknown field "${kv[1]}" (stations take ${[...STEP_KEYS].join(", ")})`);
        cur.fields[kv[1]] = kv[2].trim();
        continue;
      }
      cur.inFields = false;
      if (raw.trim() === "") continue;
    }
    cur.body.push(raw);
  }
  flush();
  if (!steps.length) throw new RecipeError(`${base}: a recipe needs at least one station (a "## Title" section)`);

  return {
    name,
    title: typeof d.title === "string" && d.title ? d.title : name,
    version,
    file,
    preamble: preamble.join("\n").trim(),
    steps,
    styles,
    defaultStyle,
    context: strList("context") ?? [],
    tools: strList("tools"),
    model: d.model === undefined || d.model === null ? null : String(d.model),
    permissions: permissions as RecipeSpec["permissions"],
    timeout: d.timeout === undefined || d.timeout === null ? null : String(d.timeout),
  };
}

export async function loadRecipe(file: string): Promise<RecipeSpec> {
  return parseRecipe(await readText(file), file);
}

// ---- timetables ---------------------------------------------------------------

/** One entry of a lines block's timetable (`lists/<id>.yaml`). Extra fields ride along into the item. */
export interface TimetableEntry {
  id: string;
  title: string;
  brief: string;
  [k: string]: unknown;
}

export async function readTimetable(file: string): Promise<TimetableEntry[]> {
  if (!(await exists(file))) return [];
  let raw: unknown;
  try {
    raw = YAML.parse(await readText(file));
  } catch (e) {
    throw new Error(`${path.basename(file)}: invalid YAML: ${(e as Error).message}`);
  }
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${path.basename(file)}: must be a list of entries`);
  const out: TimetableEntry[] = [];
  const ids = new Set<string>();
  raw.forEach((el, i) => {
    let e: TimetableEntry;
    if (typeof el === "string") e = { id: slugify(el), title: el, brief: "" };
    else if (el && typeof el === "object" && !Array.isArray(el)) {
      const o = el as Record<string, unknown>;
      const title = typeof o.title === "string" && o.title ? o.title : typeof o.id === "string" ? o.id : `entry ${i + 1}`;
      e = { ...o, id: typeof o.id === "string" && o.id ? slugify(o.id) : slugify(title), title, brief: typeof o.brief === "string" ? o.brief : "" };
    } else throw new Error(`${path.basename(file)}: entry ${i + 1} must be a string or a mapping`);
    if (ids.has(e.id)) throw new Error(`${path.basename(file)}: two entries share the id "${e.id}"`);
    ids.add(e.id);
    out.push(e);
  });
  return out;
}

export async function appendTimetableEntry(file: string, entry: { title: string; brief?: string }): Promise<TimetableEntry> {
  const current = await readTimetable(file);
  let id = slugify(entry.title);
  let n = 2;
  while (current.some((e) => e.id === id)) id = `${slugify(entry.title)}-${n++}`;
  const e: TimetableEntry = { id, title: entry.title.trim(), brief: (entry.brief ?? "").trim() };
  const doc = current.map((c) => ({ ...c }));
  doc.push(e);
  await writeText(file, YAML.stringify(doc, { lineWidth: 0 }));
  return e;
}
