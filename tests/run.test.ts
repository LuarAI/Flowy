import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../src/api.js";
import { base, engines, fileExists, makeWorkflow, nodeWrite, read, runWf } from "./helpers.js";

describe("run: linear, cache, traces", () => {
  it("runs a→b, materializes inputs, writes result/trace/signature, caches on rerun", async () => {
    const dir = await makeWorkflow(base);
    const { store, summary } = await runWf(dir);
    expect(summary.status).toBe("done");
    expect(summary.ran).toEqual(["a", "b"]);

    const bDir = store.versionDir({ node: "b" }, "v1");
    expect(await read(store, "nodes/b/current")).toBe("v1\n");
    const inListing = await fs.readFile(path.join(bDir, "out", "_in.txt"), "utf8");
    expect(inListing).toContain("_inputs.json");
    expect(inListing).toContain("a/a.md");
    expect(await fs.readFile(path.join(bDir, "in", "a", "a.md"), "utf8")).toBe("hello from a\n");

    const result = JSON.parse(await fs.readFile(path.join(bDir, "result.json"), "utf8"));
    expect(result.status).toBe("done");
    expect(result.outputs["b.md"].bytes).toBeGreaterThan(0);
    expect(result.cost_usd).toBeCloseTo(0.001);
    const trace = (await fs.readFile(path.join(bDir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(trace[0].type).toBe("start");
    expect(trace.at(-1).type).toBe("end");
    expect(await fileExists(path.join(bDir, "signature.json"))).toBe(true);
    expect(await fileExists(path.join(bDir, "prompt.md"))).toBe(true);

    // second run: everything cached, no new versions
    const again = await runWf(dir, { runId: store.run.id });
    expect(again.summary.cached).toEqual(["a", "b"]);
    expect(again.summary.ran).toEqual([]);
    expect(await store.versions({ node: "b" })).toEqual(["v1"]);
  });

  it("script nodes run in the version dir with FLOWY_* env and capture logs", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: s\nengine: { default: mock }\ninputs:\n  who: { type: string, default: world }\nnodes: [s]\n",
      "nodes/s.md": `---\nid: s\nmode: script\nrun: ${nodeWrite("hi.txt", "hi")} && node -e "console.log('who='+process.env.FLOWY_INPUT_WHO);console.error('warn')"\noutputs: [hi.txt]\n---\nwrites hi\n`,
    });
    const { store, summary } = await runWf(dir);
    expect(summary.status).toBe("done");
    const v = store.versionDir({ node: "s" }, "v1");
    expect(await fs.readFile(path.join(v, "out", "hi.txt"), "utf8")).toBe("hi");
    expect(await fs.readFile(path.join(v, "stdout.log"), "utf8")).toContain("who=world");
    expect(await fs.readFile(path.join(v, "stderr.log"), "utf8")).toContain("warn");
  });

  it("marks missing outputs and failures, and retries them on the next run", async () => {
    const dir = await makeWorkflow({
      ...base,
      "nodes/a.md": "---\nid: a\nmode: agent\noutputs: [a.md]\n---\nMOCK_FAIL boom\n",
    });
    const first = await runWf(dir);
    expect(first.summary.status).toBe("failed");
    const v1 = await api.nodeDetail(first.store, { node: "a" });
    expect(v1.view.status).toBe("failed");
    expect(v1.view.result?.error).toBe("boom");
    // b never ran
    expect(await first.store.versions({ node: "b" })).toEqual([]);

    await fs.writeFile(path.join(dir, "nodes", "a.md"), "---\nid: a\nmode: agent\noutputs: [a.md, other.md]\n---\nMOCK_NO_DEFAULTS\nMOCK_WRITE a.md <<< ok\n");
    const second = await runWf(dir, { runId: first.store.run.id, recompile: true });
    const v2 = await api.nodeDetail(second.store, { node: "a" });
    expect(v2.view.version).toBe("v2");
    expect(v2.view.status).toBe("missing_output");
    expect(v2.view.result?.error).toContain("other.md");
  });
});

describe("gates", () => {
  const files = {
    ...base,
    "nodes/a.md": `---
id: a
mode: agent
outputs: [a.md]
approve:
  chosen: { type: integer, required: true }
  notes: { type: string }
---
MOCK_WRITE a.md <<< options
`,
  };

  it("pauses at a gate, approval is data downstream, re-approval makes downstream stale", async () => {
    const dir = await makeWorkflow(files);
    const first = await runWf(dir);
    expect(first.summary.status).toBe("idle");
    expect(first.summary.pending.map((p) => p.addr.node)).toEqual(["a"]);
    expect(await first.store.versions({ node: "b" })).toEqual([]);
    const ov = await api.overview(first.store);
    expect(ov.nodes[0].status).toBe("gate");

    await expect(api.approve(first.store, { node: "a" }, { notes: "x" })).rejects.toThrow(/missing required field "chosen"/);
    await expect(api.approve(first.store, { node: "a" }, { chosen: "3", extra: 1 })).rejects.toThrow(/unknown field "extra"/);
    await api.approve(first.store, { node: "a" }, { chosen: "3", notes: "shorter" });

    const second = await runWf(dir, { runId: first.store.run.id });
    expect(second.summary.status).toBe("done");
    const bDir = second.store.versionDir({ node: "b" }, "v1");
    const approval = await fs.readFile(path.join(bDir, "in", "a", "approval.yaml"), "utf8");
    expect(approval).toContain("chosen: 3");
    expect(approval).toContain("notes: shorter");

    // re-approving with different data invalidates b
    await api.approve(second.store, { node: "a" }, { chosen: 1 });
    const ov2 = await api.overview(second.store);
    expect(ov2.nodes[1].status).toBe("stale");
    expect(ov2.nodes[1].staleReasons.join()).toContain("a/approval.yaml");
    const third = await runWf(dir, { runId: first.store.run.id });
    expect(third.summary.ran).toEqual(["b"]);
    expect(await third.store.current({ node: "b" })).toBe("v2");
  });

  it("rerun with feedback creates a new version with feedback.md, _previous and the same session", async () => {
    const dir = await makeWorkflow(files);
    const { store } = await runWf(dir);
    const r = await api.rerun(store, { node: "a" }, { feedback: "make it punchier", engines });
    expect(r.version).toBe("v2");
    expect(r.status).toBe("done");
    const v2 = store.versionDir({ node: "a" }, "v2");
    expect(await fs.readFile(path.join(v2, "feedback.md"), "utf8")).toContain("punchier");
    expect(await fs.readFile(path.join(v2, "prompt.md"), "utf8")).toContain("## Feedback on the previous attempt");
    expect(await fileExists(path.join(v2, "in", "_previous", "a.md"))).toBe(true);
    const r1 = await store.readResult(store.versionDir({ node: "a" }, "v1"));
    expect(r.session_id).toBe(r1!.session_id);
    expect(await store.current({ node: "a" })).toBe("v2");
    // a new version at a gate is again pending approval
    expect((await api.overview(store)).nodes[0].status).toBe("gate");
  });

  it("use <version> repoints and downstream becomes stale when content differs", async () => {
    const dir = await makeWorkflow(base);
    const { store } = await runWf(dir);
    await fs.writeFile(path.join(dir, "nodes", "a.md"), base["nodes/a.md"].replace("hello from a", "changed"));
    // rerun a under the recompiled manifest
    const second = await runWf(dir, { runId: store.run.id, recompile: true });
    expect(second.summary.ran).toEqual(["a", "b"]);
    expect(await store.current({ node: "a" })).toBe("v2");
    await api.useVersion(second.store, { node: "a" }, "v1");
    const ov = await api.overview(second.store);
    expect(ov.nodes[0].version).toBe("v1");
    expect(ov.nodes[1].status).toBe("stale");
  });
});

describe("foreach", () => {
  const files = {
    "workflow.yaml": `flowy: 0
name: fe
engine: { default: mock }
stagger_ms: 0
concurrency: 4
nodes:
  - plan
  - foreach: plan.items
    id: it
    workflow: ./it
    key: slug
    concurrency: 2
  - after
`,
    "nodes/plan.md": `---
id: plan
mode: agent
outputs: [structured.json]
schema: schemas/items.schema.json
approve:
  notes: { type: string }
---
MOCK_JSON <<< {"items":[{"slug":"One Thing","n":1},{"slug":"two","n":2},{"slug":"three","n":3}]}
`,
    "schemas/items.schema.json": JSON.stringify({ type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["slug", "n"] } } } }),
    "nodes/after.md": `---
id: after
mode: agent
needs: [it]
outputs: [_in.txt]
---
MOCK_LIST_IN
`,
    "it/workflow.yaml": "flowy: 0\nname: it\nnodes:\n  - step\n  - gate\n",
    "it/nodes/step.md": `---
id: step
mode: agent
needs: [plan]
outputs: [step.md, _in.txt]
---
MOCK_LIST_IN
MOCK_WRITE step.md <<< item {{item.slug}} n={{item.n}}
`,
    "it/nodes/gate.md": `---
id: gate
mode: agent
needs: [step]
outputs: [g.md]
approve:
  ok: { type: boolean, required: true }
---
MOCK_WRITE g.md <<< gate for {{item.slug}}
`,
  };

  it("expands items after the source gate, runs them in parallel, skips, and feeds the aggregator", async () => {
    const dir = await makeWorkflow(files);
    const first = await runWf(dir);
    expect(first.summary.status).toBe("idle");
    expect(await first.store.listItems("it")).toEqual([]);

    await api.approve(first.store, { node: "plan" }, {});
    const second = await runWf(dir, { runId: first.store.run.id });
    const items = await second.store.listItems("it");
    expect(items.map((i) => i.id)).toEqual(["one-thing", "two", "three"]);
    // every item ran step and is now at the gate
    for (const it of items) {
      const step = await api.nodeDetail(second.store, { node: "step", item: { foreach: "it", id: it.id } });
      expect(step.view.status).toBe("done");
      expect(step.outputs.find((o) => o.path === "step.md")?.text).toContain(`item ${it.item!.slug}`);
      expect(step.outputs.find((o) => o.path === "_in.txt")?.text).toContain("plan/structured.json");
      expect(step.outputs.find((o) => o.path === "_in.txt")?.text).toContain("plan/approval.yaml");
      const gate = await api.nodeDetail(second.store, { node: "gate", item: { foreach: "it", id: it.id } });
      expect(gate.view.status).toBe("gate");
    }
    expect(await second.store.versions({ node: "after" })).toEqual([]);

    await api.skipItem(second.store, "it", "three");
    await api.approve(second.store, { node: "gate", item: { foreach: "it", id: "one-thing" } }, { ok: true });
    await api.approve(second.store, { node: "gate", item: { foreach: "it", id: "two" } }, { ok: "yes" });
    const third = await runWf(dir, { runId: first.store.run.id });
    expect(third.summary.status).toBe("done");
    const after = await api.nodeDetail(third.store, { node: "after" });
    const listing = after.outputs[0].text!;
    expect(listing).toContain("it/one-thing/gate/g.md");
    expect(listing).toContain("it/one-thing/gate/approval.yaml");
    expect(listing).toContain("it/two/step/step.md");
    expect(listing).toContain("it/three/status");
    expect(listing).not.toContain("it/three/step/step.md");
    const states = await third.store.listItems("it");
    expect(states.map((i) => i.state)).toEqual(["done", "done", "skipped"]);
  });

  it("re-expansion keeps existing items and orphans vanished keys", async () => {
    const dir = await makeWorkflow(files);
    const { store } = await runWf(dir);
    await api.approve(store, { node: "plan" }, {});
    await runWf(dir, { runId: store.run.id });
    // change the plan output: drop "two", add "four"
    await fs.writeFile(path.join(dir, "nodes", "plan.md"), files["nodes/plan.md"].replace('{"slug":"two","n":2}', '{"slug":"four","n":4}'));
    await runWf(dir, { runId: store.run.id, recompile: true });
    await api.approve(store, { node: "plan" }, {});
    await runWf(dir, { runId: store.run.id });
    const items = await store.listItems("it");
    const byId = Object.fromEntries(items.map((i) => [i.id, i.state]));
    expect(byId["two"]).toBe("orphaned");
    expect(byId["four"]).toBe("running"); // ran step, waiting at gate
    // "one-thing" kept its item folder; because step declares needs: [plan] and
    // plan's output changed, step is stale and got a v2 (the Merkle rule).
    expect(await store.versions({ node: "step", item: { foreach: "it", id: "one-thing" } })).toEqual(["v1", "v2"]);
    expect(await store.versions({ node: "step", item: { foreach: "it", id: "two" } })).toEqual(["v1"]);
  });
});

describe("wait nodes, locks, until", () => {
  it("wait nodes pause until the file appears; done resumes", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: w\nengine: { default: mock }\nnodes: [rec, use]\n",
      "nodes/rec.md": "---\nid: rec\nmode: wait\noutputs: [vo.m4a]\nhint: record it\n---\nrecord\n",
      "nodes/use.md": "---\nid: use\nmode: agent\nneeds: [rec]\noutputs: [_in.txt]\n---\nMOCK_LIST_IN\n",
    });
    const first = await runWf(dir);
    expect(first.summary.status).toBe("idle");
    expect(first.summary.pending[0]).toMatchObject({ status: "waiting", hint: "record it" });
    await expect(api.markDone(first.store, { node: "rec" })).rejects.toThrow(/missing outputs/);
    const vdir = (await first.store.currentDir({ node: "rec" }))!;
    await fs.writeFile(path.join(vdir, "out", "vo.m4a"), "audio");
    const second = await runWf(dir, { runId: first.store.run.id });
    expect(second.summary.status).toBe("done");
    const use = await api.nodeDetail(second.store, { node: "use" });
    expect(use.outputs[0].text).toContain("rec/vo.m4a");
  });

  it("locks serialize nodes; --until limits scope", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: l\nengine: { default: mock }\nstagger_ms: 0\nconcurrency: 4\nlocks: { gpu: 1 }\nnodes: [x, y, z]\n",
      "nodes/x.md": "---\nid: x\nmode: agent\nlock: gpu\noutputs: [x.md]\n---\nMOCK_SLEEP 150\n",
      "nodes/y.md": "---\nid: y\nmode: agent\nlock: gpu\noutputs: [y.md]\n---\nMOCK_SLEEP 150\n",
      "nodes/z.md": "---\nid: z\nmode: agent\nneeds: [x, y]\noutputs: [z.md]\n---\nz\n",
    });
    const { store, summary } = await runWf(dir, { until: "x" });
    expect(summary.ran).toEqual(["x"]);
    expect(await store.versions({ node: "y" })).toEqual([]);
    const all = await runWf(dir, { runId: store.run.id });
    expect(all.summary.status).toBe("done");
    const rx = (await store.readResult(store.versionDir({ node: "x" }, "v1")))!;
    const ry = (await store.readResult(store.versionDir({ node: "y" }, "v1")))!;
    const overlap = Date.parse(rx.started) < Date.parse(ry.ended!) && Date.parse(ry.started) < Date.parse(rx.ended!);
    expect(overlap).toBe(false);
  });

  it("blocked pre-checks stop a node with the reason", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: p\nengine: { default: mock }\nnodes: [n]\n",
      "nodes/n.md": `---\nid: n\nmode: agent\noutputs: [n.md]\nbefore:\n  - node -e "console.error('editor is open');process.exit(3)"\n---\nx\n`,
    });
    const { store, summary } = await runWf(dir);
    expect(summary.status).toBe("failed");
    const d = await api.nodeDetail(store, { node: "n" });
    expect(d.view.status).toBe("blocked");
    expect(d.view.result?.error).toContain("editor is open");
  });
});
