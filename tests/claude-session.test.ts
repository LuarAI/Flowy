import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureSessionVisible, sessionBucket } from "../src/engines/claude.js";

const ID = "cf7abd67-b34a-4485-a751-831599299cd0";

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "flowy-sess-"));
}

describe("claude session buckets (SPEC §8.1 rule 6)", () => {
  it("encodes a cwd the way the CLI does: every non-alphanumeric becomes a dash", () => {
    // Real bucket observed on disk for this exact path.
    expect(sessionBucket("C:\\Users\\u\\Desktop\\studio\\clips\\runs\\20260902_07b107\\nodes\\hi\\v1")).toBe(
      "C--Users-u-Desktop-studio-clips-runs-20260902-07b107-nodes-hi-v1",
    );
  });

  it("copies a transcript into the target cwd's bucket so a cross-node resume can find it", async () => {
    const config = await tmp();
    const parentCwd = path.join(config, "wf", "nodes", "hi", "v1");
    const branchCwd = path.join(config, "wf", "nodes", "branch", "v1");
    const src = path.join(config, "projects", sessionBucket(parentCwd));
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, `${ID}.jsonl`), '{"turn":1}\n');

    await ensureSessionVisible(ID, branchCwd, { CLAUDE_CONFIG_DIR: config });

    const copied = path.join(config, "projects", sessionBucket(branchCwd), `${ID}.jsonl`);
    expect(await fs.readFile(copied, "utf8")).toBe('{"turn":1}\n');
  });

  it("leaves an already-visible transcript alone", async () => {
    const config = await tmp();
    const cwd = path.join(config, "wf", "nodes", "hi", "v1");
    const bucket = path.join(config, "projects", sessionBucket(cwd));
    await fs.mkdir(bucket, { recursive: true });
    await fs.writeFile(path.join(bucket, `${ID}.jsonl`), "original\n");

    await ensureSessionVisible(ID, cwd, { CLAUDE_CONFIG_DIR: config });

    expect(await fs.readFile(path.join(bucket, `${ID}.jsonl`), "utf8")).toBe("original\n");
  });

  it("is silent when the transcript exists nowhere (the CLI reports its own error)", async () => {
    const config = await tmp();
    await expect(ensureSessionVisible(ID, path.join(config, "x"), { CLAUDE_CONFIG_DIR: config })).resolves.toBeUndefined();
  });

  it("refuses a session id that is not id-shaped (it becomes a path segment)", async () => {
    const config = await tmp();
    await fs.mkdir(path.join(config, "projects"), { recursive: true });
    await expect(ensureSessionVisible("../../etc/passwd", path.join(config, "x"), { CLAUDE_CONFIG_DIR: config })).resolves.toBeUndefined();
    // Nothing was created outside projects/.
    expect(await fs.readdir(path.join(config, "projects"))).toEqual([]);
  });
});
