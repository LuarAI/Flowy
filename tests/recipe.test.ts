import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../src/api.js";
import { CompileError, compileWorkflow } from "../src/core/compile.js";
import { nodeView } from "../src/core/status.js";
import { engines, makeWorkflow, runWf } from "./helpers.js";

describe("branches (continues:)", () => {
  const files = {
    "workflow.yaml": "flowy: 0\nname: br\nengine: { default: mock }\nstagger_ms: 0\nnodes: [parent, child]\n",
    "nodes/parent.md": "---\nid: parent\nmode: agent\noutputs: [p.md]\n---\nparent work\n",
    "nodes/child.md": "---\nid: child\nmode: agent\ncontinues: parent\noutputs: [c.md]\n---\nchild work\n",
  };

  it("implies the dependency edge and forks the parent session", async () => {
    const dir = await makeWorkflow(files);
    const m = await compileWorkflow(dir);
    expect(m.nodes.child.needs).toEqual(["parent"]);
    expect(m.edges).toContainEqual({ from: "parent", to: "child" });

    const { store, summary } = await runWf(dir);
    expect(summary.status).toBe("done");
    const pres = (await store.readResult(store.versionDir({ node: "parent" }, "v1")))!;
    const trace = (await fs.readFile(path.join(store.versionDir({ node: "child" }, "v1"), "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(trace[0].payload.resume).toBe(pres.session_id);
    // the mock reports what it was asked to do in its final text
    const cres = (await store.readResult(store.versionDir({ node: "child" }, "v1")))!;
    expect(cres.session_id).toBe(pres.session_id); // mock keeps the id; the fork flag is what matters
  });

  it("rejects unknown continues targets and non-conversation parents", async () => {
    const dir = await makeWorkflow({
      ...files,
      "nodes/child.md": files["nodes/child.md"].replace("continues: parent", "continues: ghost"),
    });
    await expect(compileWorkflow(dir)).rejects.toThrow(CompileError);
    const dir2 = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: br2\nengine: { default: mock }\nnodes: [s, c]\n",
      "nodes/s.md": '---\nid: s\nmode: script\nrun: node -e "1"\noutputs: [s.md]\n---\nx\n',
      "nodes/c.md": "---\nid: c\nmode: agent\ncontinues: s\noutputs: [c.md]\n---\nx\n",
    });
    await expect(compileWorkflow(dir2)).rejects.toThrow(/can only continue an agent or chat node/);
  });
});

describe("recipes (crystallization)", () => {
  it("chat + recipe: true runs headless like an agent", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: rc\nengine: { default: mock }\nnodes: [talk]\n",
      "nodes/talk.md": "---\nid: talk\nmode: chat\nrecipe: true\noutputs: [t.md]\n---\nMOCK_WRITE t.md <<< from the recipe\n",
    });
    const { store, summary } = await runWf(dir);
    expect(summary.status).toBe("done");
    expect(await fs.readFile(path.join(store.versionDir({ node: "talk" }, "v1"), "out", "t.md"), "utf8")).toBe("from the recipe\n");
  });

  it("crystallize rewrites the node body, marks recipe: true, and does not go stale on itself", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: cz\nengine: { default: mock }\nnodes: [talk, after]\n",
      "nodes/talk.md": "---\nid: talk\nmode: chat\noutputs: [notes.md]\n---\nLet's figure this step out together.\n",
      "nodes/after.md": "---\nid: after\nmode: agent\nneeds: [talk]\noutputs: [a.md]\n---\nx\n",
    });
    // first run: the chat waits for the human
    const first = await runWf(dir);
    expect(first.summary.pending.map((p) => p.addr.node)).toEqual(["talk"]);
    const store = first.store;
    const vdir = (await store.currentDir({ node: "talk" }))!;

    // the human talks (simulated): outputs appear, and the session id was recorded
    await fs.writeFile(path.join(vdir, "out", "notes.md"), "what we decided\n");
    await api.markDone(store, { node: "talk" });
    const res = (await store.readResult(vdir))!;
    res.session_id = "mock-chat-session";
    await store.writeResult(vdir, res);

    // crystallize: the mock's final answer becomes the recipe
    const r = await api.crystallize(store, { node: "talk" }, engines);
    expect(r.recipe).toContain("resumed mock-chat-session, forked");
    const file = await fs.readFile(path.join(dir, "nodes", "talk.md"), "utf8");
    expect(file).toContain("recipe: true");
    expect(file).toContain(r.recipe);
    // the crystallize trace is kept
    expect(await fs.readFile(path.join(vdir, "crystallize.jsonl"), "utf8")).toContain("start");

    // learning must not mark the node stale against its own recipe
    const v = await nodeView(store, { node: "talk" });
    expect(v.status).toBe("done");
    expect(v.recipe).toBe(true);

    // downstream runs; and a later re-run of the whole thing executes the chat headless
    const second = await runWf(dir, { runId: store.run.id });
    expect(second.summary.status).toBe("done");
    const third = await runWf(dir); // a brand-new run: no waiting, the recipe runs alone
    expect(third.summary.status).toBe("done");
    expect(third.summary.pending).toEqual([]);
    const talkV1 = third.store.versionDir({ node: "talk" }, "v1");
    const result = (await third.store.readResult(talkV1))!;
    expect(result.status).toBe("done");
    expect(result.engine).toBe("mock"); // ran headless
  });

  it("a feedback rerun on a recipe node re-distills the recipe", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: fb\nengine: { default: mock }\nnodes: [talk]\n",
      "nodes/talk.md": "---\nid: talk\nmode: chat\nrecipe: true\noutputs: [t.md]\n---\nold recipe text\n",
    });
    const { store } = await runWf(dir);
    const before = await fs.readFile(path.join(dir, "nodes", "talk.md"), "utf8");
    expect(before).toContain("old recipe text");
    await api.rerun(store, { node: "talk" }, { feedback: "tighter next time", engines });
    const after = await fs.readFile(path.join(dir, "nodes", "talk.md"), "utf8");
    // the mock's distillation answer replaced the old recipe
    expect(after).not.toContain("old recipe text");
    expect(after).toContain("resumed");
    expect(after).toContain("recipe: true");
  });
});
