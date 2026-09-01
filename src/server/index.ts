import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { WebSocketServer, type WebSocket } from "ws";
import * as api from "../api.js";
import { CompileError, compileWorkflow } from "../core/compile.js";
import { exists } from "../core/fsutil.js";
import { addEdge, addNode, removeEdge, removeNode, updateNode } from "../core/graphedit.js";
import { ensureLayout, readLayout, updatePositions } from "../core/layout.js";
import { listRuns, loadRun } from "../core/runstore.js";
import type { EngineRegistry } from "../engines/index.js";
import type { Manifest, NodeAddr } from "../core/types.js";

export interface ServeOptions {
  port: number;
  engines: EngineRegistry;
  log: (m: string) => void;
  host?: string;
}

/**
 * The local viewer's server (SPEC §13). Localhost only, no auth: a window
 * onto local files. Every POST maps to an `api.*` call the CLI also exposes.
 */
export async function startServer(dir: string, opts: ServeOptions): Promise<http.Server> {
  const host = opts.host ?? "127.0.0.1";
  const staticDir = await findStaticDir();
  const clients = new Set<WebSocket>();
  let running: { runId: string; ac: AbortController } | null = null;
  const logs: string[] = [];

  const log = (m: string) => {
    opts.log(m);
    logs.push(m);
    if (logs.length > 500) logs.shift();
    broadcast({ type: "log", message: m });
  };
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === c.OPEN) c.send(s);
  };

  async function state(runId?: string) {
    let manifest: Manifest | null = null;
    let compileError: string | null = null;
    try {
      manifest = await compileWorkflow(dir, { engines: opts.engines.names() });
      await ensureLayout(manifest);
    } catch (e) {
      compileError = e instanceof CompileError ? e.message : String((e as Error).message ?? e);
    }
    const runs = await listRuns(dir);
    const store = await loadRun(dir, runId).catch(() => null);
    const overview = store ? await api.overview(store) : null;
    const layout = await readLayout(dir);
    return {
      dir,
      manifest: manifest ?? store?.manifest ?? null,
      liveManifestDiffers: !!(manifest && store && JSON.stringify(stripCompiledAt(manifest)) !== JSON.stringify(stripCompiledAt(store.manifest))),
      compileError,
      layout,
      runs,
      overview,
      running: running ? running.runId : null,
      logs: logs.slice(-200),
    };
  }

  let pushTimer: NodeJS.Timeout | null = null;
  const schedulePush = () => {
    if (pushTimer) return;
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      try {
        broadcast({ type: "state", state: await state(running?.runId) });
      } catch (e) {
        broadcast({ type: "error", message: String((e as Error).message ?? e) });
      }
    }, 250);
  };

  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    ignored: (p: string) => /node_modules|\.git[\\/]|[\\/]in[\\/]|trace\.jsonl$|stdout\.log$|stderr\.log$|\.lock$/.test(p),
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  });
  watcher.on("all", schedulePush);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith("/api/")) {
        const body = req.method === "POST" ? await readBody(req) : {};
        const result = await route(url, body);
        json(res, 200, result ?? { ok: true });
        return;
      }
      await serveStatic(res, staticDir, url.pathname);
    } catch (e) {
      const msg = e instanceof CompileError ? e.message : ((e as Error).message ?? String(e));
      json(res, 400, { error: msg });
    }
  });

  async function route(url: URL, body: Record<string, unknown>): Promise<unknown> {
    const q = (k: string) => url.searchParams.get(k) ?? (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const addr = (): NodeAddr => {
      const node = q("node");
      if (!node) throw new Error("node is required");
      const item = q("item");
      return item ? { node, item: { foreach: item.split("/")[0], id: item.split("/").slice(1).join("/") } } : { node };
    };
    const store = async () => api.getStore(dir, q("run") ?? undefined);

    switch (url.pathname) {
      case "/api/state":
        return state(q("run") ?? undefined);
      case "/api/node":
        return api.nodeDetail(await store(), addr(), { version: q("version") ?? undefined });
      case "/api/file": {
        const s = await store();
        const a = addr();
        const version = q("version") ?? (await s.current(a));
        if (!version) throw new Error("no version");
        const rel = q("path") ?? "";
        const base = path.join(s.versionDir(a, version), "out");
        const abs = path.resolve(base, rel);
        if (!abs.startsWith(base)) throw new Error("path outside out/");
        return { __file: abs };
      }
      case "/api/run": {
        if (running) throw new Error(`a run is already in progress (${running.runId})`);
        const ac = new AbortController();
        const runId = (q("run") as string | undefined) ?? undefined;
        const until = q("until") ?? undefined;
        const inputs = (body.inputs as Record<string, unknown>) ?? {};
        const recompile = body.recompile === true;
        running = { runId: runId ?? "(new)", ac };
        broadcast({ type: "running", runId: running.runId });
        void api
          .run(dir, {
            inputs,
            runId,
            recompile,
            until,
            signal: ac.signal,
            log,
            engines: opts.engines,
            emit: (e) => {
              if (e.type === "node") broadcast({ type: "node", addr: e.addr, status: e.status, version: e.version, message: e.message });
              schedulePush();
            },
          })
          .then(({ store, summary }) => {
            running = null;
            log(`run ${store.run.id}: ${summary.status}`);
            broadcast({ type: "running", runId: null });
            schedulePush();
          })
          .catch((e) => {
            running = null;
            log(`run failed: ${(e as Error).message}`);
            broadcast({ type: "running", runId: null });
            schedulePush();
          });
        return { started: true };
      }
      case "/api/stop":
        if (!running) return { stopped: false };
        running.ac.abort();
        return { stopped: true };
      case "/api/approve": {
        const s = await store();
        await api.approve(s, addr(), (body.fields as Record<string, unknown>) ?? {}, "viewer");
        schedulePush();
        return { ok: true };
      }
      case "/api/rerun": {
        const s = await store();
        if (running) throw new Error("stop the run first");
        const a = addr();
        const ac = new AbortController();
        running = { runId: s.run.id, ac };
        broadcast({ type: "running", runId: s.run.id });
        void api
          .rerun(s, a, { feedback: q("feedback") ?? undefined, engines: opts.engines, signal: ac.signal, log, emit: () => schedulePush() })
          .then((r) => log(`${api.addrLabel(a)} ${r.version}: ${r.status}`))
          .catch((e) => log(`rerun failed: ${(e as Error).message}`))
          .finally(() => {
            running = null;
            broadcast({ type: "running", runId: null });
            schedulePush();
          });
        return { started: true };
      }
      case "/api/use": {
        const s = await store();
        await api.useVersion(s, addr(), q("version")!);
        schedulePush();
        return { ok: true };
      }
      case "/api/skip": {
        const s = await store();
        const fe = q("foreach")!;
        await api.skipItem(s, fe, q("item")!, body.undo !== true);
        schedulePush();
        return { ok: true };
      }
      case "/api/done": {
        const s = await store();
        await api.markDone(s, addr());
        schedulePush();
        return { ok: true };
      }
      case "/api/layout":
        await updatePositions(dir, (body.positions as Record<string, { x: number; y: number }>) ?? {});
        return { ok: true };
      case "/api/graph/edge": {
        const from = q("from")!;
        const to = q("to")!;
        if (body.op === "remove") await removeEdge(dir, from, to);
        else await addEdge(dir, from, to);
        schedulePush();
        return { ok: true };
      }
      case "/api/graph/node": {
        if (body.op === "remove") await removeNode(dir, q("id")!);
        else if (body.op === "update") await updateNode(dir, q("id")!, { body: q("body") ?? undefined, fields: body.fields as Record<string, unknown> | undefined });
        else {
          await addNode(dir, {
            id: q("id")!,
            mode: (q("mode") as "agent") ?? "agent",
            title: q("title") ?? undefined,
            needs: Array.isArray(body.needs) ? (body.needs as string[]) : undefined,
            outputs: Array.isArray(body.outputs) ? (body.outputs as string[]) : undefined,
            run: q("runCmd") ?? undefined,
            body: q("body") ?? undefined,
          });
        }
        schedulePush();
        return { ok: true };
      }
      case "/api/chat-command": {
        const a = addr();
        const s = await store();
        return { command: `flowy chat ${a.node}${a.item ? ` --item ${a.item.foreach}/${a.item.id}` : ""} --dir "${dir}" --run ${s.run.id}` };
      }
      default:
        throw new Error(`unknown route ${url.pathname}`);
    }
  }

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", async (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    try {
      ws.send(JSON.stringify({ type: "state", state: await state(running?.runId) }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: String((e as Error).message ?? e) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port, host, resolve));
  opts.log(`Flowy viewer: http://${host}:${opts.port}/  (workflow: ${dir})`);
  if (!staticDir) opts.log("viewer assets not built — run `npm run build` in the Flowy repo; the API is still available under /api/");
  return server;
}

function stripCompiledAt(m: Manifest) {
  const { compiledAt: _c, ...rest } = m;
  return rest;
}

async function findStaticDir(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.join(here, "..", "viewer"), path.join(here, "..", "..", "dist", "viewer")]) {
    if (await exists(path.join(c, "index.html"))) return c;
  }
  return null;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("body must be JSON");
  }
}

function json(res: http.ServerResponse, status: number, v: unknown) {
  if (v && typeof v === "object" && "__file" in (v as object)) {
    const file = (v as { __file: string }).__file;
    fs.readFile(file)
      .then((buf) => {
        res.writeHead(200, { "content-type": mime(file), "content-length": buf.length });
        res.end(buf);
      })
      .catch((e) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message) }));
      });
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(v));
}

async function serveStatic(res: http.ServerResponse, staticDir: string | null, pathname: string) {
  if (!staticDir) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Flowy</title><body style="font-family:system-ui;padding:2rem"><h1>Flowy</h1><p>The viewer is not built. Run <code>npm run build</code> in the Flowy repository, then restart <code>flowy serve</code>.</p><p>The API is available under <code>/api/state</code>.</p></body>`);
    return;
  }
  let rel = pathname === "/" ? "/index.html" : pathname;
  let abs = path.resolve(staticDir, "." + rel);
  if (!abs.startsWith(staticDir)) abs = path.join(staticDir, "index.html");
  if (!(await exists(abs))) abs = path.join(staticDir, "index.html");
  const buf = await fs.readFile(abs);
  res.writeHead(200, { "content-type": mime(abs), "content-length": buf.length });
  res.end(buf);
}

function mime(f: string): string {
  const ext = path.extname(f).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".srt": "text/plain; charset=utf-8",
      ".mp4": "video/mp4",
      ".m4a": "audio/mp4",
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
    }[ext] ?? "application/octet-stream"
  );
}
