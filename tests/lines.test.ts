import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../src/api.js";
import { CompileError, compileWorkflow } from "../src/core/compile.js";
import { installRecipe, transcriptOf } from "../src/core/distill.js";
import { readLine } from "../src/core/lines.js";
import { appendTimetableEntry, parseRecipe, readTimetable, RecipeError } from "../src/core/recipe.js";
import { engines, makeWorkflow, runWf } from "./helpers.js";

const RECIPE = `---
name: shorts
title: Shorts
version: 3
styles:
  default: screen-above
  screen-above: "\\nMOCK_WRITE style.txt <<< screen-above"
  fingers: "\\nMOCK_WRITE style.txt <<< fingers"
---

Rules that hold everywhere.
MOCK_WRITE preamble.txt <<< departed

## Hook options
gate: confirm
expects: hooks.md

Draft ten hooks.
MOCK_WRITE hooks.md <<< ten hooks

## Record the voice-over
gate: you

Ask for the recording.

## Build the draft
gate: auto
expects: draft.md

Build it.
MOCK_WRITE draft.md <<< built

## Titles
gate: auto

Write five titles.
`;

const WF = {
  "workflow.yaml": `flowy: 0
name: lines-wf
engine: { default: mock }
stagger_ms: 0
nodes:
  - prep
  - lines: shorts
    id: short
    needs: [prep]
    concurrency: 2
  - wrap
`,
  "nodes/prep.md": "---\nid: prep\nmode: agent\noutputs: [p.md]\n---\nMOCK_WRITE p.md <<< prepared\n",
  "nodes/wrap.md": "---\nid: wrap\nmode: agent\nneeds: [short]\noutputs: [w.md, _in.txt]\n---\nMOCK_LIST_IN\nMOCK_WRITE w.md <<< wrapped\n",
  "recipes/shorts.md": RECIPE,
  "lists/short.yaml": `- id: lego\n  title: AI is Lego\n  brief: session 2248, min 0:19-8:46\n- Gods map\n`,
};

describe("recipes (station format)", () => {
  it("parses frontmatter, preamble, stations with fields and defaults", () => {
    const r = parseRecipe(RECIPE, "/x/recipes/shorts.md");
    expect(r.name).toBe("shorts");
    expect(r.version).toBe(3);
    expect(r.defaultStyle).toBe("screen-above");
    expect(Object.keys(r.styles)).toEqual(["screen-above", "fingers"]);
    expect(r.preamble).toContain("Rules that hold everywhere.");
    expect(r.steps.map((s) => s.id)).toEqual(["hook-options", "record-the-voice-over", "build-the-draft", "titles"]);
    expect(r.steps[0]).toMatchObject({ gate: "confirm", expects: ["hooks.md"] });
    expect(r.steps[1].gate).toBe("you");
    expect(r.steps[3]).toMatchObject({ gate: "auto", expects: [] });
    expect(r.steps[0].body).toContain("Draft ten hooks.");
    expect(r.steps[0].body).not.toContain("gate:");
  });

  it("rejects unknown fields, bad gates, and recipes without stations", () => {
    expect(() => parseRecipe("---\nname: a\nfoo: 1\n---\n## S\nx\n", "/r/a.md")).toThrow(RecipeError);
    expect(() => parseRecipe("---\nname: a\n---\n## S\ngate: maybe\n\nx\n", "/r/a.md")).toThrow(/gate must be one of/);
    expect(() => parseRecipe("---\nname: a\n---\njust a preamble\n", "/r/a.md")).toThrow(/at least one station/);
    expect(() => parseRecipe("---\nname: a\n---\n## S\nwhat: 1\n\nx\n", "/r/a.md")).toThrow(/unknown field "what"/);
    expect(() => parseRecipe("---\nname: a\nstyles: { default: nope }\n---\n## S\nx\n", "/r/a.md")).toThrow(/styles.default/);
  });

  it("timetables accept strings and mappings, refuse duplicate ids, and grow by appending", async () => {
    const dir = await makeWorkflow({ "lists/t.yaml": "- Hello there\n- id: two\n  title: Second\n  brief: b\n  extra: 7\n" });
    const f = path.join(dir, "lists", "t.yaml");
    const tt = await readTimetable(f);
    expect(tt.map((e) => e.id)).toEqual(["hello-there", "two"]);
    expect(tt[1]).toMatchObject({ title: "Second", brief: "b", extra: 7 });
    const added = await appendTimetableEntry(f, { title: "Hello there", brief: "again" });
    expect(added.id).toBe("hello-there-2");
    expect((await readTimetable(f)).length).toBe(3);
    await fs.writeFile(f, "- id: x\n- id: x\n");
    await expect(readTimetable(f)).rejects.toThrow(/share the id/);
  });
});

describe("lines blocks", () => {
  it("compile: a lines block becomes a foreach with a recipe and one synthesized chat node", async () => {
    const dir = await makeWorkflow(WF);
    const m = await compileWorkflow(dir);
    expect(m.foreach.short).toMatchObject({ recipe: "shorts", source: null, needs: ["prep"], nodes: ["short-line"], concurrency: 2 });
    expect(m.foreach.short.list).toBe(path.join(dir, "lists", "short.yaml"));
    expect(m.recipes.shorts.version).toBe(3);
    expect(m.nodes["short-line"]).toMatchObject({ mode: "chat", recipeRef: "shorts", foreach: "short", cache: "never", outputs: [] });
    expect(m.edges).toContainEqual({ from: "prep", to: "short" });
    expect(m.edges).toContainEqual({ from: "short", to: "wrap" });
  });

  it("compile: a missing recipe or an unknown trunk node is an error", async () => {
    const dir = await makeWorkflow({ ...WF, "workflow.yaml": WF["workflow.yaml"].replace("lines: shorts", "lines: ghost") });
    await expect(compileWorkflow(dir)).rejects.toThrow(/recipe not found/);
    const dir2 = await makeWorkflow({ ...WF, "workflow.yaml": WF["workflow.yaml"].replace("needs: [prep]", "needs: [nope]") });
    await expect(compileWorkflow(dir2)).rejects.toThrow(CompileError);
  });

  it("depart → stations one at a time: confirm waits, you takes the human's words, auto chains, the line arrives", async () => {
    const dir = await makeWorkflow(WF);
    const { store, summary } = await runWf(dir);
    // the trunk ran; the lines block waits for departures; nothing downstream
    expect(summary.ran).toContain("prep");
    expect(summary.status).toBe("idle");

    const [ls] = await api.depart(store, "short", [{ id: "lego", style: "fingers" }], { engines });
    expect(ls.state).toBe("waiting");
    expect(ls.step).toBe(0);
    expect(ls.style).toBe("fingers");
    const addr = { node: "short-line", item: { foreach: "short", id: "lego" } };
    const vdir = (await store.currentDir(addr))!;
    // the departure preamble went out once, with the style; the station opened with a marker in the trace
    expect(await fs.readFile(path.join(vdir, "out", "preamble.txt"), "utf8")).toBe("departed\n");
    expect(await fs.readFile(path.join(vdir, "out", "style.txt"), "utf8")).toBe("fingers\n");
    expect(await fs.readFile(path.join(vdir, "out", "hooks.md"), "utf8")).toBe("ten hooks\n");
    const trace = () =>
      fs.readFile(path.join(vdir, "trace.jsonl"), "utf8").then((t) =>
        t
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
          .filter((e) => e.type === "user"),
      );
    let users = await trace();
    expect(users[0].payload.station).toMatchObject({ index: 0, total: 4, id: "hook-options", gate: "confirm" });
    expect(users[0].payload.text).toContain("Station 1 of 4");
    expect(users[0].payload.text).not.toContain("Record the voice-over"); // the next station is never disclosed
    // the trunk's output reached the line's in/
    expect(await fs.readFile(path.join(vdir, "in", "prep", "p.md"), "utf8")).toBe("prepared\n");

    // the human talks within the station: a normal turn, still waiting at the same station
    await api.sendChatMessage(store, addr, "make hook 3 shorter", engines);
    expect((await readLine(store, "short", "lego"))!.step).toBe(0);

    // next → the "you" station: the agent asks and waits
    const s2 = await api.lineNext(store, "short", "lego", { engines });
    expect(s2).toMatchObject({ step: 1, state: "waiting" });
    users = await trace();
    expect(users[users.length - 1].payload.text).toContain("This station belongs to the human");

    // the human's answer moves the line on; auto stations chain until the end
    const s3 = await api.lineNext(store, "short", "lego", { engines }, "here is the m4a: in/vo.m4a");
    expect(s3.state).toBe("done");
    expect(s3.history.map((h) => h.id)).toEqual(["hook-options", "record-the-voice-over", "build-the-draft", "titles"]);
    users = await trace();
    const st3 = users.find((u) => u.payload.station?.index === 2)!;
    expect(st3.payload.text).toContain("The human says:\nhere is the m4a");
    expect(await fs.readFile(path.join(vdir, "out", "draft.md"), "utf8")).toBe("built\n");
    // the conversation is done, the item is done, and downstream can run with the line's files
    expect((await store.readResult(vdir))!.status).toBe("done");
    expect(await store.itemState("short", "lego")).toBe("done");
    const again = await runWf(dir, { runId: store.run.id });
    expect(again.summary.ran).toContain("wrap");
    const seen = await fs.readFile(path.join(again.store.versionDir({ node: "wrap" }, "v1"), "out", "_in.txt"), "utf8");
    expect(seen).toContain("short/lego/short-line/draft.md");

    // the overview sees it all
    const ov = await api.linesOverview(store);
    expect(ov[0].timetable).toEqual([
      { id: "lego", title: "AI is Lego", brief: "session 2248, min 0:19-8:46", started: true },
      { id: "gods-map", title: "Gods map", brief: "", started: false },
    ]);
    expect(ov[0].lines[0]).toMatchObject({ item: "lego", title: "AI is Lego", gate: null, parked: false });
    expect(ov[0].lines[0].line.state).toBe("done");
  });

  it("an auto station that leaves no expected file stops the line with a note; resume reruns it", async () => {
    const recipe = RECIPE.replace("Build it.\nMOCK_WRITE draft.md <<< built", "Build it (forgets the file).");
    const dir = await makeWorkflow({ ...WF, "recipes/shorts.md": recipe });
    const { store } = await runWf(dir);
    await api.depart(store, "short", [{ id: "gods-map" }], { engines });
    await api.lineNext(store, "short", "gods-map", { engines });
    const s = await api.lineNext(store, "short", "gods-map", { engines }, "recorded");
    expect(s).toMatchObject({ step: 2, state: "waiting" });
    expect(s.note).toContain("draft.md");
    // the human drops the file and moves on
    const vdir = (await store.currentDir({ node: "short-line", item: { foreach: "short", id: "gods-map" } }))!;
    await fs.writeFile(path.join(vdir, "out", "draft.md"), "by hand\n");
    const r = await api.lineResume(store, "short", "gods-map", { engines });
    expect(r.state).toBe("done"); // the station reran, found the file, and the last auto station followed
    // default style applied when none is picked
    expect((await readLine(store, "short", "gods-map"))!.style).toBe("screen-above");
  });

  it("a line keeps the recipe it departed with; new departures follow the edited file", async () => {
    const dir = await makeWorkflow(WF);
    const { store } = await runWf(dir);
    await api.depart(store, "short", [{ id: "lego" }], { engines });
    // the recipe changes on disk and the run adopts it (as the viewer does)
    await fs.writeFile(path.join(dir, "recipes", "shorts.md"), RECIPE.replace("version: 3", "version: 4").replace("## Titles\ngate: auto\n\nWrite five titles.\n", ""));
    store.manifest = await compileWorkflow(dir);
    await api.depart(store, "short", [{ id: "gods-map" }], { engines });
    const ov = await api.linesOverview(store);
    const lego = ov[0].lines.find((l) => l.item === "lego")!;
    const gods = ov[0].lines.find((l) => l.item === "gods-map")!;
    expect(lego.line.version).toBe(3);
    expect(lego.steps.length).toBe(4);
    expect(gods.line.version).toBe(4);
    expect(gods.steps.length).toBe(3);
    expect(ov[0].liveVersion).toBe(4);
  });

  it("a waiting line can be updated to the edited recipe; its next station is the new one", async () => {
    const dir = await makeWorkflow(WF);
    const { store } = await runWf(dir);
    await api.depart(store, "short", [{ id: "lego" }], { engines });
    await api.lineNext(store, "short", "lego", { engines }); // now at station 2 (Record, you)
    await fs.writeFile(path.join(dir, "recipes", "shorts.md"), RECIPE.replace("version: 3", "version: 4").replace("## Titles\ngate: auto\n\nWrite five titles.\n", ""));
    store.manifest = await compileWorkflow(dir);
    const u = await api.lineUpdate(store, "short", "lego");
    expect(u.version).toBe(4);
    expect(u.step).toBe(1);
    const ov = await api.linesOverview(store);
    expect(ov[0].lines[0].steps.length).toBe(3);
    // the remaining stations follow the new recipe: Build is now the last one
    const s = await api.lineNext(store, "short", "lego", { engines }, "recorded");
    expect(s.state).toBe("done");
    await expect(api.lineUpdate(store, "short", "lego")).rejects.toThrow(/arrived/);
  });

  it("a station the loop guard stopped waits with Flowy's note, and the retry prompt carries it", async () => {
    const recipe = RECIPE.replace("Build it.\nMOCK_WRITE draft.md <<< built", "Build it.\nMOCK_GUARD two replies in a row exceeded the model's output limit");
    const dir = await makeWorkflow({ ...WF, "recipes/shorts.md": recipe });
    const { store } = await runWf(dir);
    await api.depart(store, "short", [{ id: "lego" }], { engines });
    await api.lineNext(store, "short", "lego", { engines }); // the human's station: no engine turn, just the marker
    const vdir = (await store.currentDir({ node: "short-line", item: { foreach: "short", id: "lego" } }))!;
    const users = () => fs.readFile(path.join(vdir, "trace.jsonl"), "utf8").then((t) => t.trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "user"));
    let u = await users();
    expect(u[u.length - 1].engine).toBe("flowy");
    expect(u[u.length - 1].payload.station).toMatchObject({ index: 1, gate: "you" });
    const s = await api.lineNext(store, "short", "lego", { engines }, "recorded");
    expect(s.state).toBe("waiting");
    expect(s.step).toBe(2);
    expect(s.note).toMatch(/^stopped by Flowy — two replies/);
    u = await users();
    // the build prompt carried the human's station text and their words
    const build = u.find((x) => x.payload.station?.index === 2)!;
    expect(build.payload.text).toContain("was the human's own");
    expect(build.payload.text).toContain("The human says:\nrecorded");
    // resuming under a fixed recipe: the prompt tells the agent why it was stopped
    await fs.writeFile(path.join(dir, "recipes", "shorts.md"), RECIPE);
    store.manifest = await compileWorkflow(dir);
    await api.lineUpdate(store, "short", "lego");
    const r = await api.lineResume(store, "short", "lego", { engines });
    expect(r.state).toBe("done");
    u = await users();
    const retry = u.filter((x) => x.payload.station?.index === 2).pop()!;
    expect(retry.payload.text).toContain("Note from Flowy: the previous attempt at this station was two replies in a row");
  });

  it("refuses unknown entries, unknown styles, and departing twice", async () => {
    const dir = await makeWorkflow(WF);
    const { store } = await runWf(dir);
    await expect(api.depart(store, "short", [{ id: "nope" }], { engines })).rejects.toThrow(/not on the timetable/);
    await expect(api.depart(store, "short", [{ id: "lego", style: "vhs" }], { engines })).rejects.toThrow(/no style "vhs"/);
    await api.depart(store, "short", [{ id: "lego" }], { engines });
    await expect(api.depart(store, "short", [{ id: "lego" }], { engines })).rejects.toThrow(/already departed/);
    const added = await api.addTimetableEntry(store, "short", { title: "Zero to Ellipsis", brief: "la objeción" });
    expect(added.id).toBe("zero-to-ellipsis");
    expect((await api.linesOverview(store))[0].timetable.map((t) => t.id)).toContain("zero-to-ellipsis");
  });
});

describe("chats see inputs wired after they started", () => {
  it("a context file attached mid-conversation lands in in/ and the next message says so", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: late\nengine: { default: mock }\nnodes: [talk]\n",
      "nodes/talk.md": "---\nid: talk\nmode: chat\n---\n",
      "context/late.md": "arrived late\n",
    });
    const { store } = await runWf(dir);
    await api.sendChatMessage(store, { node: "talk" }, "hi", engines);
    const vdir = (await store.currentDir({ node: "talk" }))!;
    expect(await fs.stat(path.join(vdir, "in", "context", "late.md")).catch(() => null)).toBeNull();
    // the human wires context/late.md on the canvas; the run adopts the live workflow
    await fs.writeFile(path.join(dir, "nodes", "talk.md"), "---\nid: talk\nmode: chat\ncontext: [context/late.md]\n---\n");
    store.manifest = await compileWorkflow(dir);
    await api.sendChatMessage(store, { node: "talk" }, "did you get it?", engines);
    expect(await fs.readFile(path.join(vdir, "in", "context", "late.md"), "utf8")).toBe("arrived late\n");
    const users = (await fs.readFile(path.join(vdir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "user")
      .map((e) => e.payload.text);
    expect(users[1]).toContain("(new under ./in since we started: in/context/late.md)");
    expect(users[1]).toContain("did you get it?");
  });
});

describe("distilling recipes", () => {
  it("transcripts keep what was said and which files were touched, not the reasoning", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: d\nengine: { default: mock }\nnodes: [talk]\n",
      "nodes/talk.md": "---\nid: talk\nmode: chat\n---\n",
    });
    const { store } = await runWf(dir);
    await api.sendChatMessage(store, { node: "talk" }, "MOCK_WRITE hooks.md <<< h", engines);
    const t = await transcriptOf((await store.currentDir({ node: "talk" }))!);
    expect(t).toContain("**Human:** MOCK_WRITE hooks.md");
    expect(t).toContain("**Agent:** mock done");
    expect(t).toContain("[Write: out/hooks.md]");
  });

  it("installRecipe validates, numbers the version, and gives the recipe a lines block", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: d\nengine: { default: mock }\nnodes: [talk]\n",
      "nodes/talk.md": "---\nid: talk\nmode: chat\n---\n",
    });
    const draft = "---\nname: whatever\nversion: 9\n---\nrules\n\n## First\ngate: auto\n\ndo it\n";
    const r1 = await installRecipe(dir, "posts", draft);
    expect(r1.recipe.version).toBe(1);
    expect(r1.linesId).toBe("posts");
    const wf = await fs.readFile(path.join(dir, "workflow.yaml"), "utf8");
    expect(wf).toContain("- lines: posts");
    const m = await compileWorkflow(dir);
    expect(m.foreach.posts.recipe).toBe("posts");
    // the next install is the next version and adds no second block
    const r2 = await installRecipe(dir, "posts", draft);
    expect(r2.recipe.version).toBe(2);
    expect(r2.linesId).toBeNull();
    expect((await fs.readFile(path.join(dir, "recipes", "posts.md"), "utf8")).match(/lines: posts/g)?.length ?? 0).toBe(0);
    await expect(installRecipe(dir, "bad", "---\nname: bad\n---\nno stations\n")).rejects.toThrow(RecipeError);
  });

  it("the mock engine cannot write a real recipe: distill fails clearly and keeps the draft", async () => {
    const dir = await makeWorkflow({
      "workflow.yaml": "flowy: 0\nname: d\nengine: { default: mock }\nnodes: [talk]\n",
      "nodes/talk.md": "---\nid: talk\nmode: chat\n---\n",
    });
    const { store } = await runWf(dir);
    await api.sendChatMessage(store, { node: "talk" }, "hello", engines);
    await expect(api.distill(store, "shorts", [{ node: "talk" }], engines)).rejects.toThrow(/not valid.*draft kept/);
  });
});
