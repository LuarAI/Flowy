import path from "node:path";
import { promises as fs } from "node:fs";
import type { EngineRegistry } from "../engines/index.js";
import { nowIso, readText, writeJson, writeText } from "./fsutil.js";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import type { RunStore } from "./runstore.js";
import { computeSignature, engineConfigFor, engineName } from "./status.js";
import type { NodeAddr, TraceEvent } from "./types.js";

/**
 * Crystallization (SPEC §2.5): turn a node's finished conversation into a
 * recipe — the instruction that lets the same work happen headless next
 * time. The recipe becomes the node's body; a chat node additionally gets
 * `recipe: true` so future runs skip the conversation. Re-crystallizing
 * after feedback or another chat updates the recipe — the workflow learns.
 */

const CRYSTALLIZE_PROMPT = `The work of this step is finished. Now write the RECIPE: the instruction that would let you (or another agent) produce this step's outputs again for NEW inputs of the same kind, headless, without this conversation.

Rules for the recipe:
- Address the future agent directly ("Read in/… , write out/…").
- Fold in everything the human corrected or decided along the way, as standing rules — not as history. Never mention "the user said" or reference this conversation.
- Leave out anything specific to this particular batch of inputs (names, counts, contents); describe the *kind* of thing instead.
- Name the exact files to read under in/ and the exact files to produce under out/.
- Plain text, no heading, no code fence, no preamble. Output ONLY the recipe.`;

export interface CrystallizeResult {
  recipe: string;
  file: string;
}

export async function crystallizeNode(
  store: RunStore,
  addr: NodeAddr,
  engines: EngineRegistry,
  opts: { log?: (m: string) => void; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<CrystallizeResult> {
  const spec = store.manifest.nodes[addr.node];
  if (!spec) throw new Error(`unknown node "${addr.node}"`);
  if (spec.mode !== "chat" && spec.mode !== "agent") throw new Error(`"${addr.node}" is a ${spec.mode} node; recipes come from conversations (chat or agent nodes)`);
  const vdir = await store.currentDir(addr);
  if (!vdir) throw new Error(`"${addr.node}" has not run yet — there is no conversation to learn from`);
  const result = await store.readResult(vdir);
  if (!result?.session_id) throw new Error(`"${addr.node}" has no recorded session to learn from`);
  const engine = engines.get(engineName(store, spec));
  if (!engine.capabilities.includes("resume")) throw new Error(`engine "${engine.name}" cannot resume a session`);

  const traceFile = path.join(vdir, "crystallize.jsonl");
  const events: TraceEvent[] = [];
  const er = await engine.run({
    cwd: vdir,
    prompt: CRYSTALLIZE_PROMPT,
    tools: ["Read"],
    outputs: [],
    schema: null,
    timeoutMs: 5 * 60_000,
    resumeSession: result.session_id,
    forkSession: true, // never pollute the real conversation
    addDirs: [],
    config: engineConfigFor(store, spec),
    env: opts.env ?? process.env,
    signal: opts.signal ?? new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  await fs.appendFile(traceFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n").catch(() => {});
  if (er.exitCode !== 0 || !er.text?.trim()) throw new Error(`could not distill the recipe${er.error ? `: ${er.error.split("\n")[0]}` : ""}`);

  let recipe = er.text.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(recipe);
  if (fence) recipe = fence[1].trim();

  // 1. The authoring file: the body becomes the recipe.
  const fm = parseFrontmatter(await readText(spec.file));
  if (spec.mode === "chat") fm.data.recipe = true;
  await writeText(spec.file, stringifyFrontmatter(fm.data, recipe));

  // 2. The run's frozen manifest follows, so this run replays with the recipe too.
  spec.body = recipe;
  if (spec.mode === "chat") spec.recipe = true;
  await writeJson(path.join(store.run.dir, "manifest.json"), store.manifest);

  // 3. Refresh the current version's signature so learning never marks the
  //    node stale against its own recipe (the work it just did IS the recipe's work).
  const sig = await computeSignature(store, addr);
  if (sig) await store.writeSignature(vdir, sig);

  opts.log?.(`✎ ${addr.node}: recipe learned (${recipe.length} chars) — ${nowIso()}`);
  return { recipe, file: spec.file };
}
