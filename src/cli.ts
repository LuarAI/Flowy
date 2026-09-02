#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import * as api from "./api.js";
import { CompileError } from "./core/compile.js";
import { readJsonOrNull } from "./core/fsutil.js";
import { parseAddr } from "./core/runstore.js";
import { EngineRegistry } from "./engines/index.js";

const program = new Command();
program.name("flowy").description("Local, file-based workflows for your own agent CLI.").version("0.1.0");

const engines = new EngineRegistry();
const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

function fail(e: unknown): never {
  if (e instanceof CompileError) err(e.message);
  else err(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

function parseInputs(list: string[] | undefined): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const kv of list ?? []) {
    const i = kv.indexOf("=");
    if (i < 0) throw new Error(`--input expects key=value (got "${kv}")`);
    o[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return o;
}

function abortOnSigint(): AbortController {
  const ac = new AbortController();
  let n = 0;
  process.on("SIGINT", () => {
    n++;
    if (n === 1) {
      err("\nstopping — waiting for running nodes to finish cleanly (Ctrl+C again to force)");
      ac.abort();
    } else process.exit(130);
  });
  return ac;
}

program
  .command("compile [dir]")
  .description("validate the workflow and write .flowy/manifest.json (no run)")
  .action(async (dir = ".") => {
    try {
      const m = await api.compile(path.resolve(dir), engines);
      out(`ok: ${m.name} — ${Object.keys(m.nodes).length} nodes, ${Object.keys(m.foreach).length} foreach`);
      out(api.formatPlan(m));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("run [dir]")
  .description("start or resume a run and drive it until a human is needed")
  .option("-i, --input <k=v...>", "run inputs")
  .option("-u, --until <node>", "stop after this top-level node")
  .option("-r, --run <id>", "resume this run id")
  .option("--recompile", "when resuming, recompile the workflow into the run")
  .option("--dry", "compile and print the plan without running")
  .action(async (dir = ".", o: { input?: string[]; until?: string; run?: string; recompile?: boolean; dry?: boolean }) => {
    try {
      const abs = path.resolve(dir);
      if (o.dry) {
        const m = await api.compile(abs, engines);
        out(api.formatPlan(m));
        return;
      }
      const ac = abortOnSigint();
      const { store, summary } = await api.run(abs, {
        inputs: parseInputs(o.input),
        runId: o.run,
        recompile: o.recompile,
        until: o.until,
        signal: ac.signal,
        log: out,
        engines,
      });
      out("");
      out(api.formatOverview(await api.overview(store)));
      out("");
      out(`run ${store.run.id}: ${summary.status}${summary.ran.length ? `, ran ${summary.ran.length}` : ""}${summary.cached.length ? `, cached ${summary.cached.length}` : ""}${summary.failed.length ? `, failed ${summary.failed.length}` : ""}`);
      process.exit(summary.status === "failed" ? 1 : 0);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("runs [dir]")
  .description("list runs, newest first")
  .action(async (dir = ".") => {
    const { listRuns } = await import("./core/runstore.js");
    const ids = await listRuns(path.resolve(dir));
    if (!ids.length) out("(no runs)");
    for (const id of ids) {
      const r = await readJsonOrNull<{ status?: string }>(path.join(path.resolve(dir), "runs", id, "manifest.json"));
      out(`${id}${r ? "" : "  (no manifest)"}`);
    }
  });

program
  .command("status [dir]")
  .description("nodes, items, gates, costs of the latest (or --run) run")
  .option("-r, --run <id>")
  .action(async (dir = ".", o: { run?: string }) => {
    try {
      const store = await api.getStore(path.resolve(dir), o.run);
      out(api.formatOverview(await api.overview(store)));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("approve <node>")
  .description("approve a gate: flowy approve hooks --set chosen=3 --set notes=\"shorter\"")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--item <foreach/item-id>")
  .option("-s, --set <k=v...>", "approval fields")
  .action(async (node: string, o: { dir: string; run?: string; item?: string; set?: string[] }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      await api.approve(store, parseAddr(node, o.item), parseInputs(o.set));
      out(`approved ${node}${o.item ? ` (${o.item})` : ""}. Continue with: flowy run --run ${store.run.id}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("rerun <node>")
  .description("run a node again as a new version, optionally with feedback")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--item <foreach/item-id>")
  .option("-f, --feedback <text>")
  .action(async (node: string, o: { dir: string; run?: string; item?: string; feedback?: string }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      const ac = abortOnSigint();
      const r = await api.rerun(store, parseAddr(node, o.item), { feedback: o.feedback, engines, signal: ac.signal, log: out });
      out(`${node} ${r.version}: ${r.status}${r.error ? ` — ${r.error.split("\n")[0]}` : ""}${r.cost_usd ? `  $${r.cost_usd.toFixed(3)}` : ""}`);
      out(`downstream nodes are now stale; continue with: flowy run --run ${store.run.id}`);
      process.exit(r.status === "done" || r.status === "waiting" ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("use <node> <version>")
  .description("make a version current (downstream becomes stale)")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--item <foreach/item-id>")
  .action(async (node: string, version: string, o: { dir: string; run?: string; item?: string }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      await api.useVersion(store, parseAddr(node, o.item), version);
      out(`${node} → ${version}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("chat <node>")
  .description("open the engine interactively in the node's directory (chat mode, or to continue a gated agent node)")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--item <foreach/item-id>")
  .action(async (node: string, o: { dir: string; run?: string; item?: string }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      const r = await api.chat(store, parseAddr(node, o.item), engines, process.env, { log: out });
      out(
        r.crystallized
          ? `session ended — and the recipe is learned: next time this step runs by itself.`
          : `session ended (${r.code}). If the outputs are in place the node is done; otherwise run \`flowy done ${node}\` once they are.`,
      );
    } catch (e) {
      fail(e);
    }
  });

program
  .command("recipe <node>")
  .description("distill the node's finished conversation into its recipe (it then runs headless next time)")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--item <foreach/item-id>")
  .action(async (node: string, o: { dir: string; run?: string; item?: string }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      const r = await api.crystallize(store, parseAddr(node, o.item), engines, out);
      out(`recipe written to ${r.file}:`);
      out("");
      out(r.recipe.split("\n").slice(0, 12).join("\n") + (r.recipe.split("\n").length > 12 ? "\n…" : ""));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("done <node>")
  .description("mark a wait/chat node complete once its outputs exist")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--item <foreach/item-id>")
  .action(async (node: string, o: { dir: string; run?: string; item?: string }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      await api.markDone(store, parseAddr(node, o.item));
      out(`${node} done. Continue with: flowy run --run ${store.run.id}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("skip <foreach/item-id>")
  .description("skip an item (the 'not now' pile); --undo to bring it back")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--undo")
  .action(async (target: string, o: { dir: string; run?: string; undo?: boolean }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      const a = parseAddr("x", target);
      await api.skipItem(store, a.item!.foreach, a.item!.id, !o.undo);
      out(`${target}: ${o.undo ? "pending" : "skipped"}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("stop [dir]")
  .description("interrupt the scheduler driving the latest run")
  .option("-r, --run <id>")
  .action(async (dir = ".", o: { run?: string }) => {
    try {
      const store = await api.getStore(path.resolve(dir), o.run);
      const { runLockHolder } = await import("./core/scheduler.js");
      const pid = await runLockHolder(store);
      if (!pid) {
        out("nothing is running");
        return;
      }
      process.kill(pid, "SIGINT");
      out(`sent SIGINT to pid ${pid}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("trace <node>")
  .description("print a node's result and trace")
  .option("-d, --dir <dir>", "workflow folder", ".")
  .option("-r, --run <id>")
  .option("--item <foreach/item-id>")
  .option("-v, --version <vN>")
  .option("--raw", "print trace.jsonl payloads")
  .action(async (node: string, o: { dir: string; run?: string; item?: string; version?: string; raw?: boolean }) => {
    try {
      const store = await api.getStore(path.resolve(o.dir), o.run);
      const d = await api.nodeDetail(store, parseAddr(node, o.item), { version: o.version });
      out(`${node} ${d.view.version ?? "(no version)"} — ${d.view.status}`);
      if (d.view.result) out(JSON.stringify({ ...d.view.result, outputs: Object.keys(d.view.result.outputs) }, null, 2));
      if (d.view.staleReasons.length) out(`stale: ${d.view.staleReasons.join("; ")}`);
      out("");
      for (const e of d.trace) {
        if (o.raw) out(JSON.stringify(e));
        else out(`${e.t.slice(11, 19)} ${e.type.padEnd(11)} ${summarize(e.payload)}`);
      }
      if (d.stderr) out(`\nstderr:\n${d.stderr}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("layout [dir]")
  .description("(re)generate layout.canvas positions for nodes that lack them")
  .action(async (dir = ".") => {
    try {
      const m = await api.compile(path.resolve(dir), engines);
      out(`layout.canvas updated for ${m.name}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("serve [dir]")
  .description("start the local viewer")
  .option("-p, --port <n>", "port", "3579")
  .option("--no-open", "do not print the URL hint")
  .action(async (dir = ".", o: { port: string }) => {
    try {
      const { startServer } = await import("./server/index.js");
      await startServer(path.resolve(dir), { port: parseInt(o.port, 10), engines, log: out });
    } catch (e) {
      fail(e);
    }
  });

function summarize(p: unknown): string {
  if (typeof p === "string") return p.slice(0, 160);
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.slice(0, 160).replace(/\n/g, " ");
    if (typeof o.thinking === "string") return o.thinking.slice(0, 160).replace(/\n/g, " ");
    if (typeof o.name === "string") return `${o.name} ${JSON.stringify(o.input ?? "").slice(0, 120)}`;
    if (typeof o.command === "string") return o.command.slice(0, 160);
    return JSON.stringify(o).slice(0, 160);
  }
  return String(p);
}

program.parseAsync(process.argv).catch(fail);
