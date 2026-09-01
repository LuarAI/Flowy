import { describe, expect, it } from "vitest";
import { CompileError, compileWorkflow } from "../src/core/compile.js";
import { base, makeWorkflow } from "./helpers.js";

async function issues(files: Record<string, string>): Promise<string[]> {
  const dir = await makeWorkflow(files);
  try {
    await compileWorkflow(dir);
    return [];
  } catch (e) {
    if (e instanceof CompileError) return e.issues.map((i) => `${i.file.replace(/\\/g, "/")}${i.line ? `:${i.line}` : ""}: ${i.message}`);
    throw e;
  }
}

describe("compile", () => {
  it("compiles a minimal workflow", async () => {
    const dir = await makeWorkflow(base);
    const m = await compileWorkflow(dir);
    expect(m.top).toEqual(["a", "b"]);
    expect(m.edges).toEqual([{ from: "a", to: "b" }]);
    expect(m.nodes.b.needs).toEqual(["a"]);
    expect(m.nodes.a.tools).toEqual(["Read", "Write"]);
    expect(m.nodes.a.timeoutMs).toBe(30 * 60_000);
  });

  it("reports unknown keys, missing files, bad modes with file:line", async () => {
    const out = await issues({
      ...base,
      "workflow.yaml": base["workflow.yaml"].replace("concurrency: 3", "concurrency: 3\nbogus: 1") + "  - c\n",
      "nodes/a.md": base["nodes/a.md"].replace("mode: agent", "mode: agentic\nfoo: bar"),
    });
    expect(out.some((s) => s.includes('unknown key "bogus"'))).toBe(true);
    expect(out.some((s) => /nodes\/c\.md: node file not found/.test(s))).toBe(true);
    expect(out.some((s) => /nodes\/a\.md:3: mode must be one of/.test(s))).toBe(true);
    expect(out.some((s) => /nodes\/a\.md:4: unknown field "foo"/.test(s))).toBe(true);
  });

  it("rejects cycles and unknown needs", async () => {
    const out = await issues({
      ...base,
      "nodes/a.md": base["nodes/a.md"].replace("mode: agent", "mode: agent\nneeds: [b, zzz]"),
    });
    expect(out.some((s) => s.includes("cycle:"))).toBe(true);
    expect(out.some((s) => s.includes('needs "zzz": unknown node'))).toBe(true);
  });

  it("requires outputs and a prompt body for agent nodes", async () => {
    const out = await issues({ ...base, "nodes/a.md": "---\nid: a\nmode: agent\n---\n" });
    expect(out.some((s) => s.includes("outputs: must declare"))).toBe(true);
    expect(out.some((s) => s.includes("need a prompt body"))).toBe(true);
  });

  it("validates foreach: source must be structured, nested deps cannot be downstream", async () => {
    const out = await issues({
      "workflow.yaml": `flowy: 0
name: t
engine: { default: mock }
nodes:
  - plan
  - foreach: plan.items
    id: it
    workflow: ./it
  - after
`,
      "nodes/plan.md": "---\nid: plan\nmode: agent\noutputs: [plan.md]\n---\nx\n",
      "nodes/after.md": "---\nid: after\nmode: agent\nneeds: [it]\noutputs: [x.md]\n---\nx\n",
      "it/workflow.yaml": "flowy: 0\nname: it\nnodes:\n  - step\n",
      "it/nodes/step.md": "---\nid: step\nmode: agent\nneeds: [after]\noutputs: [s.md]\n---\nx {{item.slug}}\n",
    });
    expect(out.some((s) => s.includes("neither schema: nor an output named items.json"))).toBe(true);
    expect(out.some((s) => s.includes("downstream of the foreach"))).toBe(true);
  });

  it("accepts a valid foreach and records implicit needs", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": `flowy: 0
name: t
engine: { default: mock }
locks: { gpu: 1 }
nodes:
  - plan
  - side
  - foreach: plan.items
    id: it
    workflow: ./it
    key: slug
  - after
`,
      "nodes/plan.md": "---\nid: plan\nmode: agent\noutputs: [items.json]\n---\nx\n",
      "nodes/side.md": "---\nid: side\nmode: agent\noutputs: [side.md]\nlock: gpu\n---\nx\n",
      "nodes/after.md": "---\nid: after\nmode: agent\nneeds: [it]\noutputs: [x.md]\n---\nx\n",
      "it/workflow.yaml": "flowy: 0\nname: it\nnodes:\n  - step\n",
      "it/nodes/step.md": "---\nid: step\nmode: agent\nneeds: [side]\noutputs: [s.md]\n---\nx {{item.slug}}\n",
    });
    const m = await compileWorkflow(dir);
    expect(m.foreach.it.needs).toEqual(["plan", "side"]);
    expect(m.edges).toContainEqual({ from: "side", to: "it" });
    expect(m.edges).toContainEqual({ from: "it", to: "after" });
    expect(m.nodes.step.foreach).toBe("it");
  });

  it("rejects templates that reference undeclared inputs", async () => {
    const out = await issues({ ...base, "nodes/a.md": base["nodes/a.md"] + "\n{{inputs.nope}}\n" });
    expect(out.some((s) => s.includes("{{inputs.nope}}"))).toBe(true);
  });
});
