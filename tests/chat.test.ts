import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../src/api.js";
import { engines, makeWorkflow, runWf } from "./helpers.js";

describe("canvas chat: one engine turn per message", () => {
  const files = {
    "workflow.yaml": "flowy: 0\nname: cc\nengine: { default: mock }\nnodes: [talk, side]\n",
    "nodes/talk.md": "---\nid: talk\nmode: chat\ntitle: Talk\n---\n",
    "nodes/side.md": "---\nid: side\nmode: chat\ncontinues: talk\n---\n",
  };

  it("open chats compile without outputs/body, never auto-complete, and accumulate a transcript", async () => {
    const dir = await makeWorkflow(files);
    const { store, summary } = await runWf(dir);
    // open conversations are not pending demands on the human — nothing "needs you"
    expect(summary.status).toBe("idle");
    expect(summary.pending).toEqual([]);

    const t1 = await api.sendChatMessage(store, { node: "talk" }, "hello there", engines);
    expect(t1.text).toContain("mock answer");
    expect(t1.session).toBeTruthy();
    const t2 = await api.sendChatMessage(store, { node: "talk" }, "and again", engines);
    // second turn resumes the same session
    expect(t2.text).toContain(`resumed ${t1.session}`);

    const vdir = (await store.currentDir({ node: "talk" }))!;
    const trace = (await fs.readFile(path.join(vdir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const users = trace.filter((e) => e.type === "user").map((e) => e.payload.text);
    expect(users).toEqual(["hello there", "and again"]);
    const result = (await store.readResult(vdir))!;
    expect(result.status).toBe("waiting"); // still an open conversation
    expect(result.turns).toBe(2);
    expect(result.session_id).toBe(t1.session);
  });

  it("a branch chat's first message forks the parent's session", async () => {
    const dir = await makeWorkflow(files);
    const { store } = await runWf(dir);
    const parent = await api.sendChatMessage(store, { node: "talk" }, "parent turn", engines);
    const child = await api.sendChatMessage(store, { node: "side" }, "child turn", engines);
    expect(child.text).toContain(`resumed ${parent.session}, forked`);
  });

  it("chatting on a fresh workflow needs no run: one is created, and missing context/upstreams warn instead of failing", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: fresh\nengine: { default: mock }\ninputs:\n  brand: { type: path, required: true }\nnodes: [prep, talk]\n",
      "nodes/prep.md": "---\nid: prep\nmode: agent\noutputs: [p.md]\n---\nx\n",
      "nodes/talk.md": '---\nid: talk\nmode: chat\nneeds: [prep]\ncontext: ["{{inputs.brand}}/voice.md"]\n---\n',
    });
    // no run exists; ensureStore creates a scratch run despite the missing required input
    const { store, created } = await api.ensureStore(dir, undefined, engines);
    expect(created).toBe(true);
    const turn = await api.sendChatMessage(store, { node: "talk" }, "hola", engines);
    expect(turn.text).toContain("mock answer");
    const res = (await store.readResult((await store.currentDir({ node: "talk" }))!))!;
    const warnings = res.meta.warnings as string[];
    expect(warnings.join(" ")).toContain("voice.md");
    expect(warnings.join(" ")).toContain('"prep"');
    // second ensureStore reuses the run
    expect((await api.ensureStore(dir, undefined, engines)).created).toBe(false);
  });

  it("done is explicit for open chats", async () => {
    const dir = await makeWorkflow(files);
    const { store } = await runWf(dir);
    await api.sendChatMessage(store, { node: "talk" }, "hi", engines);
    await api.markDone(store, { node: "talk" });
    const res = (await store.readResult((await store.currentDir({ node: "talk" }))!))!;
    expect(res.status).toBe("done");
  });
});
