import path from "node:path";
import { exists, nowIso, readJsonOrNull, writeJson } from "./fsutil.js";
import { readItem } from "./materialize.js";
import type { RunStore } from "./runstore.js";
import type { LineState, NodeAddr, RecipeSpec, RecipeStep } from "./types.js";

/** Same words as the chat preamble (api.ts): the one rule that keeps an agent from looping on its own output limit. */
export const SIZE_RULE =
  "Size rule: keep every reply and every single file write under about 250 lines. Write a big file in parts (Write the first part, append the rest with Edit). Never print a whole transcript or dataset into the conversation — filter it with a small script and read only the slice you need. A reply that exceeds the model's output limit is thrown away and still paid for.";

const GUARD_PREFIX = "stopped by Flowy — ";

/**
 * Lines (SPEC §5.1): one item of a lines block, following its recipe's
 * stations in a single conversation. The agent sees exactly one station at
 * a time; `line.json` remembers where the train is.
 */

export function lineFile(store: RunStore, feId: string, itemId: string): string {
  return path.join(store.itemDir(feId, itemId), "line.json");
}

export async function readLine(store: RunStore, feId: string, itemId: string): Promise<LineState | null> {
  return readJsonOrNull<LineState>(lineFile(store, feId, itemId));
}

export async function writeLine(store: RunStore, feId: string, itemId: string, ls: LineState): Promise<void> {
  ls.updated = nowIso();
  await writeJson(lineFile(store, feId, itemId), ls);
}

/** The conversation node that carries a line. */
export function lineAddr(store: RunStore, feId: string, itemId: string): NodeAddr {
  const fe = store.manifest.foreach[feId];
  if (!fe || !fe.recipe) throw new Error(`"${feId}" is not a lines block`);
  return { node: fe.nodes[0], item: { foreach: feId, id: itemId } };
}

export function recipeOf(store: RunStore, feId: string): RecipeSpec {
  const fe = store.manifest.foreach[feId];
  if (!fe || !fe.recipe) throw new Error(`"${feId}" is not a lines block`);
  const r = store.manifest.recipes[fe.recipe];
  if (!r) throw new Error(`recipe "${fe.recipe}" is missing from this run's manifest`);
  return r;
}

/**
 * The recipe a line departed with. Snapshotted into the item folder at
 * departure, so editing recipes/<name>.md changes the next departures, never
 * a train already on the track.
 */
export async function lineRecipe(store: RunStore, feId: string, itemId: string): Promise<RecipeSpec> {
  const snap = await readJsonOrNull<RecipeSpec>(path.join(store.itemDir(feId, itemId), "recipe.json"));
  return snap ?? recipeOf(store, feId);
}

/**
 * Give a train on the track the recipe as it is now: re-snapshot from the
 * live manifest. The current station index is kept, so the new recipe must
 * still have a station there; the next station the line runs is the new
 * recipe's. Refused mid-station (the running turn was prompted from the old
 * one) and after arrival.
 */
export async function updateLineRecipe(store: RunStore, feId: string, itemId: string): Promise<LineState> {
  const ls = await readLine(store, feId, itemId);
  if (!ls) throw new Error(`no line "${feId}/${itemId}"`);
  if (ls.state === "running") throw new Error(`${feId}/${itemId} is mid-station — wait for it to stop`);
  if (ls.state === "done") throw new Error(`${feId}/${itemId} has already arrived`);
  const live = recipeOf(store, feId);
  if (ls.step >= live.steps.length) throw new Error(`recipe v${live.version} has ${live.steps.length} stations; ${feId}/${itemId} is at station ${ls.step + 1}`);
  if (ls.style && !(ls.style in live.styles)) throw new Error(`recipe v${live.version} has no style "${ls.style}"`);
  await writeJson(path.join(store.itemDir(feId, itemId), "recipe.json"), live);
  ls.version = live.version;
  await writeLine(store, feId, itemId, ls);
  return ls;
}

export interface Station {
  index: number;
  total: number;
  id: string;
  title: string;
  gate: RecipeStep["gate"];
}

export function stationOf(recipe: RecipeSpec, index: number): Station {
  const s = recipe.steps[index];
  return { index, total: recipe.steps.length, id: s.id, title: s.title, gate: s.gate };
}

/** What the agent is told when a line departs (before the first station). Sent once; the session remembers it. */
export function departurePreamble(recipe: RecipeSpec, entry: Record<string, unknown>, style: string | null): string {
  const parts: string[] = [];
  parts.push(
    `You are working one line of the "${recipe.title}" recipe, station by station. You only ever see the current station; the next one arrives when this one is done. Do not guess or start work that belongs to a later station.`,
  );
  parts.push(
    `Working directory contract: your inputs are under ./in (read-only). Put a file in ./out only when a later station or step needs it (a script, a draft, a deliverable); answer everything else in chat — never write a file just to hold a reply. Keep answers conversational and concise.`,
  );
  parts.push(SIZE_RULE);
  const title = typeof entry.title === "string" ? entry.title : String(entry.id ?? "");
  const brief = typeof entry.brief === "string" ? entry.brief : "";
  const extra = Object.entries(entry)
    .filter(([k, v]) => !k.startsWith("_") && !["id", "title", "brief"].includes(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  parts.push(`This line: ${title}${brief ? `\n${brief}` : ""}${extra.length ? `\n${extra.join("\n")}` : ""}`);
  if (style && recipe.styles[style] !== undefined) parts.push(`Style for this line — ${style}: ${recipe.styles[style] || "(no description)"}`);
  if (recipe.preamble) parts.push(recipe.preamble);
  return parts.join("\n\n") + "\n\n";
}

/** The message that opens one station. */
export function stationPrompt(recipe: RecipeSpec, index: number, humanInput: string | null, extra: { flowyNote?: string | null; carried?: RecipeStep | null } = {}): string {
  const s = recipe.steps[index];
  const lines: string[] = [];
  lines.push(`## Station ${index + 1} of ${recipe.steps.length} — ${s.title}`);
  if (extra.carried) lines.push(`\n(Station ${index} — ${extra.carried.title} — was the human's own; it read:\n${extra.carried.body.trim()})`);
  if (humanInput?.trim()) lines.push(`\nThe human says:\n${humanInput.trim()}`);
  if (extra.flowyNote) lines.push(`\nNote from Flowy: the previous attempt at this station was ${extra.flowyNote}. This time work in smaller pieces: split any big file into parts, never print a whole transcript or dataset, and keep each reply short.`);
  lines.push("");
  lines.push(s.body);
  lines.push("");
  if (s.expects.length) lines.push(`Before you finish, these files must exist in ./out: ${s.expects.join(", ")}.`);
  switch (s.gate) {
    case "you":
      lines.push(`This station belongs to the human. Say briefly what you need from them and where to put it, then stop and wait. Do not try to do their part yourself.`);
      break;
    case "confirm":
      lines.push(`When this station's work is done, say so in one line and stop. The human decides when the line moves on; they may ask for changes first.`);
      break;
    case "auto":
      lines.push(`When this station's work is done, stop. The next station follows on its own.`);
      break;
  }
  return lines.join("\n");
}

export async function missingExpects(store: RunStore, addr: NodeAddr, step: RecipeStep): Promise<string[]> {
  const vdir = await store.currentDir(addr);
  if (!vdir) return [...step.expects];
  const missing: string[] = [];
  for (const e of step.expects) if (!(await exists(path.join(vdir, "out", e)))) missing.push(e);
  return missing;
}

export interface TurnResult {
  stopped?: boolean;
  /** Why Flowy stopped it (absent when the human did). */
  note?: string;
}

export interface DriveDeps {
  /** One engine turn in the line's conversation. `preamble` is non-null only for the very first turn. */
  turn: (addr: NodeAddr, text: string, station: Station, preamble: string | null, model: string | null) => Promise<TurnResult>;
  /** Record a station marker without an engine turn (for the human's own stations). False when there is no conversation yet. */
  mark?: (addr: NodeAddr, text: string, station: Station) => Promise<boolean>;
  /** Called when the line reaches its last station: mark the conversation done. */
  finish: (addr: NodeAddr) => Promise<void>;
  log?: (m: string) => void;
  onChange?: (feId: string, itemId: string, ls: LineState) => void;
}

/**
 * Run the current station, then keep going through `auto` stations. Stops at
 * the first gate that needs the human, at a failure, or at the end of the line.
 */
export async function driveLine(store: RunStore, feId: string, itemId: string, deps: DriveDeps, humanInput: string | null = null): Promise<LineState> {
  const ls = await readLine(store, feId, itemId);
  if (!ls) throw new Error(`no line "${feId}/${itemId}"`);
  const recipe = await lineRecipe(store, feId, itemId);
  const addr = lineAddr(store, feId, itemId);
  const entry = (await readItem(store, addr)) ?? { id: itemId, title: itemId };
  const label = `${feId}/${itemId}`;
  const save = async () => {
    await writeLine(store, feId, itemId, ls);
    deps.onChange?.(feId, itemId, ls);
  };

  // A station the human's own answer moves past: its text rides along into the next prompt.
  let carried: RecipeStep | null = null;
  const prev = recipe.steps[ls.step - 1];
  if (prev?.gate === "you" && !ls.history.some((h) => h.step === ls.step)) carried = prev;
  for (;;) {
    const step = recipe.steps[ls.step];
    if (!step) {
      ls.state = "done";
      ls.note = null;
      ls.waitingSince = null;
      await save();
      await deps.finish(addr);
      deps.log?.(`✓ ${label}: arrived (${recipe.steps.length} stations)`);
      return ls;
    }
    const flowyNote = ls.note?.startsWith(GUARD_PREFIX) ? ls.note.slice(GUARD_PREFIX.length) : null;
    ls.state = "running";
    ls.note = null;
    ls.waitingSince = null;
    ls.history.push({ step: ls.step, id: step.id, started: nowIso(), ended: null });
    await save();
    if (addr.item) await store.setItemState(feId, itemId, "running");

    const vdir = await store.currentDir(addr);
    const res = vdir ? await store.readResult(vdir) : null;
    const first = !res?.session_id;
    const station = stationOf(recipe, ls.step);
    deps.log?.(`▶ ${label}: station ${ls.step + 1}/${recipe.steps.length} — ${step.title}`);
    const prompt = stationPrompt(recipe, ls.step, humanInput, { flowyNote, carried });
    carried = null;
    // The human's own station: no engine turn, just the marker. The agent reads it with the next station.
    if (step.gate === "you" && !first && deps.mark && (await deps.mark(addr, prompt, station))) {
      ls.history[ls.history.length - 1].ended = nowIso();
      humanInput = null;
      ls.state = "waiting";
      ls.note = null;
      ls.waitingSince = nowIso();
      await save();
      return ls;
    }
    let r: TurnResult;
    try {
      r = await deps.turn(addr, prompt, station, first ? departurePreamble(recipe, entry, ls.style) : null, step.model);
    } catch (e) {
      ls.history[ls.history.length - 1].ended = nowIso();
      ls.state = "failed";
      ls.note = (e as Error).message;
      ls.waitingSince = nowIso();
      await save();
      deps.log?.(`✗ ${label}: ${ls.note}`);
      return ls;
    }
    ls.history[ls.history.length - 1].ended = nowIso();
    humanInput = null;
    if (r.stopped) {
      ls.state = "waiting";
      ls.note = r.note ? `${GUARD_PREFIX}${r.note}` : "stopped by you — talk to it, resume the station, or move on";
      ls.waitingSince = nowIso();
      await save();
      return ls;
    }
    if (step.gate === "auto") {
      const missing = await missingExpects(store, addr, step);
      if (missing.length) {
        ls.state = "waiting";
        ls.note = `this station should have left ${missing.join(", ")} in out/ — have a look`;
        ls.waitingSince = nowIso();
        await save();
        return ls;
      }
      ls.step++;
      continue;
    }
    ls.state = "waiting";
    ls.note = null;
    ls.waitingSince = nowIso();
    await save();
    return ls;
  }
}

/** The human moves the line on: next station, optionally carrying what they said. */
export async function advanceLine(store: RunStore, feId: string, itemId: string, deps: DriveDeps, humanInput: string | null = null): Promise<LineState> {
  const ls = await readLine(store, feId, itemId);
  if (!ls) throw new Error(`no line "${feId}/${itemId}"`);
  if (ls.state === "running") throw new Error(`${feId}/${itemId} is mid-station — stop it first, or wait`);
  if (ls.state === "done") throw new Error(`${feId}/${itemId} has already arrived`);
  ls.step++;
  await writeLine(store, feId, itemId, ls);
  return driveLine(store, feId, itemId, deps, humanInput);
}

/** Create the item and its line.json; the caller then drives it. */
export async function createLine(store: RunStore, feId: string, entry: Record<string, unknown> & { id: string }, style: string | null, index: number): Promise<LineState> {
  const recipe = recipeOf(store, feId);
  if (style && !(style in recipe.styles)) throw new Error(`recipe "${recipe.name}" has no style "${style}" (${Object.keys(recipe.styles).join(", ") || "none declared"})`);
  const existing = await readLine(store, feId, entry.id);
  if (existing) throw new Error(`"${entry.id}" already departed on ${feId}`);
  await store.ensureItem(feId, entry.id, { ...entry, _index: index, _style: style });
  await writeJson(path.join(store.itemDir(feId, entry.id), "recipe.json"), recipe);
  const ls: LineState = {
    recipe: recipe.name,
    version: recipe.version,
    style,
    step: 0,
    state: "pending",
    note: null,
    started: nowIso(),
    updated: nowIso(),
    waitingSince: null,
    history: [],
  };
  await writeLine(store, feId, entry.id, ls);
  return ls;
}
