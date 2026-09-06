import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineRegistry } from "../engines/index.js";
import { compileWorkflow } from "./compile.js";
import { ensureDir, exists, nowIso, readText, writeText } from "./fsutil.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { addLinesBlock } from "./graphedit.js";
import { parseRecipe, RecipeError } from "./recipe.js";
import type { RunStore } from "./runstore.js";
import { engineConfig } from "./status.js";
import type { NodeAddr, RecipeSpec, TraceEvent } from "./types.js";

/**
 * Distill several finished conversations into one station recipe
 * (SPEC §2.6). The demonstrations are the same kind of work done by hand,
 * each time with the human steering; the recipe is the spine they share,
 * with the human's corrections folded in as standing rules.
 */

const FORMAT = `---
name: <name>
title: <short human title>
version: <n>
styles:            # optional — named variants of the preferences that may change from line to line
  default: <style-name>
  <style-name>: <one-line description of that variant>
---

<preamble: the rules that hold at every station — voice, formats, tools, folder conventions, gotchas, and PREFERENCES (layout choices, thresholds, fonts, levels). Preferences live here, never inside a station, so they can change without touching the spine.>

## <Station title>
gate: auto | confirm | you
expects: <comma-separated files this station must leave in out/ — optional line>

<the instruction for this station, addressed to the future agent: what to read, what to do, what to leave in out/, how to end>

## <Next station title>
gate: …

<…>`;

function distillPrompt(name: string, demos: string[], hasCurrent: boolean): string {
  const parts: string[] = [];
  parts.push(
    `You have ${demos.length} transcript${demos.length === 1 ? "" : "s"} of finished conversations under ./in (${demos.join(", ")}): the same kind of work done by hand, each time with a human steering. Distill them into ONE recipe — a sequence of stations an agent will follow later, one station at a time, for new items of the same kind. The agent following it will see only the current station, so each station must stand on its own.`,
  );
  if (hasCurrent)
    parts.push(
      `./in/current-recipe.md is the recipe as it stands today. Produce its next version: keep what still holds, fold in what the transcripts add or correct, and drop nothing without a reason visible in the transcripts.`,
    );
  parts.push(`Write the recipe to ./out/recipe.md in exactly this format (name: ${name}):\n\n${FORMAT}`);
  parts.push(`Rules:
- Make one station per phase where, in the transcripts, the human waited for something or decided something. Where the human is the worker (records audio, edits by hand, brings a file) → gate: you, and the instruction says what to ask for and where it should be put. Where the human reviews and chooses (picks an option, approves a draft, checks a result) → gate: confirm. Where the work is mechanical and the transcripts show the human never intervened → gate: auto.
- Fold the human's repeated corrections and standing instructions into rules ("always …", "never …", "before X, check Y"). Never write "the user said" and never refer to the transcripts.
- Leave out anything specific to one transcript's item (its names, numbers, dates, file paths); describe the kind of thing instead. Keep the tool names, commands, folder conventions and gotchas that repeat.
- Where the transcripts disagree on a preference (a layout, a threshold), keep the most recent one as the default and, if the older one looks like a deliberate alternative, offer it as a style.
- Keep the whole file under 300 lines; stations are instructions, not essays.
- Write only ./out/recipe.md; say nothing else.`);
  return parts.join("\n\n");
}

/** Plain transcript of a conversation: what the human and the agent said, plus which files were touched. */
export async function transcriptOf(vdir: string): Promise<string> {
  const f = path.join(vdir, "trace.jsonl");
  if (!(await exists(f))) return "";
  const out: string[] = [];
  for (const line of (await readText(f)).split("\n")) {
    if (!line.trim()) continue;
    let e: TraceEvent;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = e.payload as Record<string, unknown> | null;
    if (!p || typeof p !== "object") continue;
    if (e.type === "user" && typeof p.text === "string") {
      const st = p.station as { index: number; title: string } | undefined;
      out.push(st ? `\n### Station ${st.index + 1}: ${st.title}\n` : `\n**Human:** ${p.text}\n`);
    } else if (e.type === "text" && typeof p.text === "string") out.push(`**Agent:** ${p.text}\n`);
    else if (e.type === "tool_use" && typeof p.name === "string") {
      const input = (p.input ?? {}) as Record<string, unknown>;
      const what = typeof input.file_path === "string" ? input.file_path : typeof input.command === "string" ? input.command.slice(0, 120) : null;
      if (what && ["Write", "Edit", "Bash"].includes(p.name)) out.push(`_[${p.name}: ${what}]_`);
    }
  }
  return out.join("\n").trim();
}

export interface DistillResult {
  file: string;
  recipe: RecipeSpec;
  /** A lines block was added to workflow.yaml (none referenced this recipe yet). */
  linesId: string | null;
}

export async function distillRecipe(
  store: RunStore,
  name: string,
  chats: NodeAddr[],
  engines: EngineRegistry,
  opts: { log?: (m: string) => void; env?: NodeJS.ProcessEnv; signal?: AbortSignal; model?: string } = {},
): Promise<DistillResult> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`recipe name "${name}" must be lowercase letters, digits and dashes`);
  if (!chats.length) throw new Error("pick at least one conversation to learn from");
  const dir = store.manifest.dir;
  const recipeFile = path.join(dir, "recipes", `${name}.md`);
  const current = (await exists(recipeFile)) ? await readText(recipeFile) : null;
  const scratch = path.join(store.run.dir, "distill", `${name}-${nowIso().replace(/[:.]/g, "-")}`);
  await ensureDir(path.join(scratch, "in"));
  await ensureDir(path.join(scratch, "out"));

  const demos: string[] = [];
  for (const [i, addr] of chats.entries()) {
    const vdir = await store.currentDir(addr);
    if (!vdir) throw new Error(`"${addr.node}" has no conversation yet`);
    const t = await transcriptOf(vdir);
    if (!t) throw new Error(`"${addr.node}" has an empty conversation`);
    const label = `demo-${i + 1}-${addr.item ? `${addr.item.id}-` : ""}${addr.node}.md`;
    await writeText(path.join(scratch, "in", label), `# Demonstration ${i + 1}: ${addr.node}\n\n${t}\n`);
    demos.push(label);
  }
  if (current) await writeText(path.join(scratch, "in", "current-recipe.md"), current);

  const engine = engines.get(store.manifest.engine.default);
  const events: TraceEvent[] = [];
  const er = await engine.run({
    cwd: scratch,
    prompt: distillPrompt(name, demos, !!current),
    tools: ["Read", "Write"],
    outputs: ["recipe.md"],
    schema: null,
    timeoutMs: 20 * 60_000,
    resumeSession: null,
    forkSession: false,
    addDirs: [],
    config: { ...engineConfig(store, engine.name), ...(opts.model ? { model: opts.model } : {}) },
    env: opts.env ?? process.env,
    signal: opts.signal ?? new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  await fs.writeFile(path.join(scratch, "distill.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n").catch(() => {});
  if (er.exitCode !== 0) throw new Error(`could not distill the recipe${er.error ? `: ${er.error.split("\n")[0]}` : ""}`);
  const outFile = path.join(scratch, "out", "recipe.md");
  if (!(await exists(outFile))) throw new Error(`the distiller wrote nothing to out/recipe.md (see ${path.relative(dir, scratch)})`);

  const raw = await readText(outFile);
  let installed: DistillResult;
  try {
    installed = await installRecipe(dir, name, raw);
  } catch (e) {
    if (e instanceof RecipeError) throw new Error(`the distilled recipe is not valid: ${e.message} (draft kept at ${path.relative(dir, outFile)})`);
    throw e;
  }
  opts.log?.(
    `✎ recipe ${name} v${installed.recipe.version}: ${installed.recipe.steps.length} stations — ${path.relative(dir, installed.file)}${installed.linesId ? ` (lines "${installed.linesId}" added to workflow.yaml)` : ""}`,
  );
  return installed;
}

/**
 * Put a recipe text in place as recipes/<name>.md: validated, name and
 * version set by Flowy (the next version if one exists), and given a lines
 * block in workflow.yaml unless one already runs it.
 */
export async function installRecipe(dir: string, name: string, raw: string): Promise<DistillResult> {
  const recipeFile = path.join(dir, "recipes", `${name}.md`);
  parseRecipe(raw, recipeFile); // throws RecipeError with the reason
  const current = (await exists(recipeFile)) ? await readText(recipeFile) : null;
  const fm = parseFrontmatter(raw);
  fm.data.name = name;
  fm.data.version = (current ? parseRecipe(current, recipeFile).version : 0) + 1;
  await writeText(recipeFile, stringifyFrontmatter(fm.data, fm.body));
  const recipe = parseRecipe(await readText(recipeFile), recipeFile);

  let linesId: string | null = null;
  const m = await compileWorkflow(dir).catch(() => null);
  const referenced = m ? Object.values(m.foreach).some((fe) => fe.recipe === name) : false;
  if (!referenced) {
    linesId = m && (name in m.nodes || name in m.foreach) ? `${name}-lines` : name;
    await addLinesBlock(dir, { id: linesId, recipe: name });
  }
  return { file: recipeFile, recipe, linesId };
}
