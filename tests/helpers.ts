import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as api from "../src/api.js";
import { EngineRegistry } from "../src/engines/index.js";
import type { RunStore } from "../src/core/runstore.js";

export interface Files {
  [rel: string]: string;
}

/** Create a temp workflow folder from a map of relative path -> content. */
export async function makeWorkflow(files: Files): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flowy-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
  }
  return dir;
}

export const engines = new EngineRegistry();

export async function runWf(dir: string, opts: Partial<api.StartOptions> = {}) {
  const logs: string[] = [];
  const r = await api.run(dir, { engines, tick: 20, log: (m) => logs.push(m), ...opts });
  return { ...r, logs };
}

export async function read(store: RunStore, rel: string): Promise<string> {
  return fs.readFile(path.join(store.run.dir, rel), "utf8");
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** A script `run:` line that writes a file into out/ using node, portable across shells. */
export function nodeWrite(file: string, content: string): string {
  const js = `require('fs').writeFileSync(require('path').join(process.env.FLOWY_OUT,'${file}'),'${content}')`;
  return `node -e "${js}"`;
}

export const base = {
  "workflow.yaml": `flowy: 0
name: t
engine: { default: mock }
concurrency: 3
stagger_ms: 0
nodes:
  - a
  - b
`,
  "nodes/a.md": `---
id: a
mode: agent
outputs: [a.md]
---
MOCK_WRITE a.md <<< hello from a
`,
  "nodes/b.md": `---
id: b
mode: agent
needs: [a]
outputs: [b.md, _in.txt]
---
MOCK_LIST_IN
MOCK_WRITE b.md <<< hello from b
`,
};
