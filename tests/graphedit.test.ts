import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../src/core/compile.js";
import { addContext, addEdge, removeContext, removeNode } from "../src/core/graphedit.js";
import { makeWorkflow } from "./helpers.js";

const files = {
  "workflow.yaml": `flowy: 0
name: g
engine: { default: mock }
nodes:
  - plan
  - foreach: plan.items
    id: it
    workflow: ./it
    key: slug
  - branch
  - after
`,
  "nodes/plan.md": "---\nid: plan\nmode: agent\ncontext: [context/notes.md]\noutputs: [items.json]\n---\nx\n",
  "nodes/branch.md": "---\nid: branch\nmode: agent\ncontinues: plan\noutputs: [b.md]\n---\nx\n",
  "nodes/after.md": "---\nid: after\nmode: agent\nneeds: [it, branch]\noutputs: [a.md]\n---\nx\n",
  "it/workflow.yaml": "flowy: 0\nname: it\nnodes: [step]\n",
  "it/nodes/step.md": "---\nid: step\nmode: agent\noutputs: [s.md]\n---\nx {{item.slug}}\n",
  "context/notes.md": "notes\n",
};

describe("graph edits are cascade-resilient (delete always wins)", () => {
  it("deleting a node that feeds a checklist takes the checklist and all references with it", async () => {
    const dir = await makeWorkflow(files);
    const summary = await removeNode(dir, "plan");
    expect(summary).toContain('deleted step "plan"');
    expect(summary).toContain('removed the checklist "it"');
    expect(summary).toContain('"branch" no longer continues');
    const m = await compileWorkflow(dir);
    expect(Object.keys(m.foreach)).toEqual([]);
    expect(m.top).toEqual(["branch", "after"]);
    expect(m.nodes.after.needs).toEqual(["branch"]);
    expect(m.nodes.branch.continues).toBeNull();
    // the nested workflow folder survives on disk
    expect(await fs.readFile(path.join(dir, "it", "workflow.yaml"), "utf8")).toContain("step");
  });

  it("deleting the checklist itself removes only the block", async () => {
    const dir = await makeWorkflow(files);
    const summary = await removeNode(dir, "it");
    expect(summary).toContain('removed the checklist "it"');
    const m = await compileWorkflow(dir);
    expect(m.top).toEqual(["plan", "branch", "after"]);
    expect(m.nodes.after.needs).toEqual(["branch"]);
  });

  it("a workflow can be emptied entirely and still compiles", async () => {
    const dir = await makeWorkflow(files);
    await removeNode(dir, "plan");
    await removeNode(dir, "branch");
    await removeNode(dir, "after");
    const m = await compileWorkflow(dir);
    expect(m.top).toEqual([]);
    expect(Object.keys(m.nodes)).toEqual([]);
  });

  it("context attach/detach and edges round-trip", async () => {
    const dir = await makeWorkflow(files);
    await addContext(dir, "after", "context/notes.md");
    let m = await compileWorkflow(dir);
    expect(m.nodes.after.context).toEqual(["context/notes.md"]);
    await removeContext(dir, "after", "context/notes.md");
    await addEdge(dir, "plan", "branch");
    m = await compileWorkflow(dir);
    expect(m.nodes.after.context).toEqual([]);
    expect(m.nodes.branch.needs).toContain("plan");
  });
});

describe("addNode adapts to the workflow.yaml list style", () => {
  it("appends into a flow-style `nodes: [a]` list without corrupting the YAML", async () => {
    const { addNode } = await import("../src/core/graphedit.js");
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: fl\nengine: { default: mock }\nnodes: [hi]\n",
      "nodes/hi.md": "---\nid: hi\nmode: chat\n---\n",
    });
    await addNode(dir, { id: "twist", mode: "chat", title: "Twist", continues: "hi" });
    const wf = await fs.readFile(path.join(dir, "workflow.yaml"), "utf8");
    expect(wf).toContain("nodes: [hi, twist]");
    const m = await compileWorkflow(dir);
    expect(Object.keys(m.nodes).sort()).toEqual(["hi", "twist"]);
    expect(m.nodes.twist.continues).toBe("hi");
  });

  it("appends into an empty flow list `nodes: []`", async () => {
    const { addNode } = await import("../src/core/graphedit.js");
    const dir = await makeWorkflow({ "workflow.yaml": "flowy: 0\nname: fl\nengine: { default: mock }\nnodes: []\n" });
    await addNode(dir, { id: "solo", mode: "chat", title: "Solo" });
    const m = await compileWorkflow(dir);
    expect(Object.keys(m.nodes)).toEqual(["solo"]);
  });
});
