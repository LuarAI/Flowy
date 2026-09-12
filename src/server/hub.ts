import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { EngineRegistry } from "../engines/index.js";

/**
 * The hub: one address for every workflow (SPEC §9).
 *
 * Running a server per workflow means remembering which port is which, and a
 * workflow's URL changing between sessions. The hub owns a single port, keeps a
 * registry of workflow folders, starts each one's server on an ephemeral port the
 * human never sees, and proxies by path prefix:
 *
 *   /w/<slug>/            the viewer for that workflow
 *   /w/<slug>/api/...     that workflow's API, unchanged
 *   /api/hub/workspaces   the registry itself, for the sidebar
 *
 * Each workflow keeps its own isolated server, so runs, watchers and in-flight
 * turns behave exactly as before; only the address changes.
 */

export interface Workspace {
  slug: string;
  name: string;
  dir: string;
  /** Set once its server is up. */
  port?: number;
  /** Null until first visited: servers start lazily, so a hub with ten workflows costs one process until used. */
  server?: http.Server | null;
  error?: string | null;
}

const REGISTRY = () => path.join(process.env.USERPROFILE || process.env.HOME || ".", ".flowy", "workspaces.json");

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "workflow";
}

export async function readRegistry(): Promise<Array<{ name: string; dir: string }>> {
  try {
    const raw = await fs.readFile(REGISTRY(), "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j?.workspaces) ? j.workspaces : [];
  } catch {
    return [];
  }
}

export async function writeRegistry(list: Array<{ name: string; dir: string }>): Promise<void> {
  const f = REGISTRY();
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, JSON.stringify({ workspaces: list }, null, 2), "utf8");
}

/** Workflow name from its workflow.yaml, falling back to the folder name. */
async function workflowName(dir: string): Promise<string> {
  try {
    const text = await fs.readFile(path.join(dir, "workflow.yaml"), "utf8");
    const m = /^name:\s*(.+)$/m.exec(text);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    /* fall through */
  }
  return path.basename(dir);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startHub(opts: { port: number; engines: EngineRegistry; log: (m: string) => void }): Promise<http.Server> {
  const entries = await readRegistry();
  const spaces = new Map<string, Workspace>();
  for (const e of entries) {
    const slug = slugify(e.name || path.basename(e.dir));
    spaces.set(slug, { slug, name: e.name || path.basename(e.dir), dir: e.dir, server: null, error: null });
  }

  const { startServer } = await import("./index.js");

  /** Start a workflow's own server on demand; repeated calls return the same one. */
  const ensure = async (w: Workspace): Promise<Workspace> => {
    if (w.server || w.port) return w;
    try {
      const port = await freePort();
      const srv = await startServer(w.dir, { port, engines: opts.engines, log: (m) => opts.log(`[${w.slug}] ${m}`) });
      w.server = srv;
      w.port = port;
      w.error = null;
      opts.log(`workspace "${w.name}" ready`);
    } catch (e) {
      w.error = (e as Error).message;
      opts.log(`workspace "${w.name}" failed: ${w.error}`);
    }
    return w;
  };

  const proxy = (req: http.IncomingMessage, res: http.ServerResponse, port: number, rest: string) => {
    const p = http.request(
      { host: "127.0.0.1", port, path: rest || "/", method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    p.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `workspace unreachable: ${e.message}` }));
    });
    req.pipe(p);
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    // The registry itself
    if (url.startsWith("/api/hub/workspaces")) {
      if (req.method === "POST") {
        const body = await new Promise<string>((r) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => r(b));
        });
        try {
          const { dir } = JSON.parse(body || "{}");
          const abs = path.resolve(String(dir));
          await fs.access(path.join(abs, "workflow.yaml"));
          const name = await workflowName(abs);
          const slug = slugify(name);
          spaces.set(slug, { slug, name, dir: abs, server: null, error: null });
          await writeRegistry([...spaces.values()].map((w) => ({ name: w.name, dir: w.dir })));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ slug, name }));
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `not a workflow folder: ${(e as Error).message}` }));
        }
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        workspaces: [...spaces.values()].map((w) => ({ slug: w.slug, name: w.name, dir: w.dir, running: !!w.server, error: w.error ?? null })),
      }));
      return;
    }

    // /w/<slug>/...  ->  that workflow's own server
    const m = /^\/w\/([^/]+)(\/.*)?$/.exec(url);
    if (m) {
      const w = spaces.get(m[1]);
      if (!w) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no workspace "${m[1]}"` }));
        return;
      }
      await ensure(w);
      if (!w.port) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: w.error ?? "workspace did not start" }));
        return;
      }
      proxy(req, res, w.port, m[2] ?? "/");
      return;
    }

    // Bare root: send the human to the first workspace, or explain the empty hub.
    if (url === "/" || url === "") {
      const first = [...spaces.values()][0];
      if (first) {
        res.writeHead(302, { location: `/w/${first.slug}/` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>flowy</title>
        <body style="font:14px system-ui;margin:60px auto;max-width:38em;color:#26231f">
        <h1 style="font-weight:800">flowy</h1>
        <p>No workflows registered yet. Add one:</p>
        <pre style="background:#f5f1e8;padding:10px;border-radius:6px">flowy hub --add &lt;path to workflow folder&gt;</pre>
        </body>`);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  // WebSocket upgrades belong to the workspace the path names.
  server.on("upgrade", async (req, socket, head) => {
    const m = /^\/w\/([^/]+)(\/.*)?$/.exec(req.url ?? "");
    const w = m ? spaces.get(m[1]) : undefined;
    if (!w) {
      socket.destroy();
      return;
    }
    await ensure(w);
    if (!w.port) {
      socket.destroy();
      return;
    }
    const up = http.request({
      host: "127.0.0.1",
      port: w.port,
      path: m![2] ?? "/",
      method: "GET",
      headers: { ...req.headers, host: `127.0.0.1:${w.port}` },
    });
    up.on("upgrade", (upRes, upSocket, upHead) => {
      const head_ = `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";
      socket.write(head_);
      if (upHead?.length) socket.unshift(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      upSocket.on("error", () => socket.destroy());
      socket.on("error", () => upSocket.destroy());
    });
    up.on("error", () => socket.destroy());
    if (head?.length) up.write(head);
    up.end();
  });

  await new Promise<void>((r) => server.listen(opts.port, "127.0.0.1", r));
  opts.log(`flowy hub on http://127.0.0.1:${opts.port} — ${spaces.size} workspace${spaces.size === 1 ? "" : "s"}`);
  return server;
}
