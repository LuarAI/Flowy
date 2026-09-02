import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { addrParams, get, post, type ForeachView, type NodeAddr, type NodeView, type State, type TraceEvent } from "./client";
import { renderMarkdown } from "./markdown";
import { collectSources, entryFor, humanMode, humanStatus, itemWorst, placeholderView, relativeEntry, NEEDS_YOU, WRONG, type SourcePill } from "./model";
import { Box, Check, FileIcon, Folder, Pencil, Play } from "./icons";

/*
 * The canvas of chats: context pills flow into chat cards; each chat card
 * holds a real conversation (every message is one engine turn in that node's
 * isolated directory). Branch = a new chat carrying the parent conversation.
 * Arrows connect; Delete removes (the workflow adapts, server-side cascade).
 */

interface Sketch {
  elements: unknown[];
  sources: Record<string, { x: number; y: number }>;
  unattached?: string[];
}

export interface OpenTarget {
  kind: "step" | "item" | "checklist";
  addr?: NodeAddr;
  foreach?: string;
  id?: string;
}

interface Ctx {
  state: State;
  onOpen: (t: OpenTarget) => void;
  onError: (msg: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  sketch: () => Sketch;
  saveSketch: () => void;
  refreshKey: number;
}

/* ---------------- chat card ---------------- */

interface ChatMsg {
  role: "user" | "assistant" | "tool" | "note";
  text: string;
}

function traceToMessages(trace: TraceEvent[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const e of trace) {
    const p = e.payload as Record<string, unknown> | string | null;
    if (e.type === "user" && p && typeof p === "object" && typeof p.text === "string") out.push({ role: "user", text: p.text });
    else if (e.type === "text" && p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string") out.push({ role: "assistant", text: String((p as Record<string, unknown>).text) });
    else if (e.type === "tool_use" && p && typeof p === "object" && typeof (p as Record<string, unknown>).name === "string") {
      // say WHAT it touched, not just the tool name
      const input = ((p as Record<string, unknown>).input ?? {}) as Record<string, unknown>;
      let detail = "";
      if (typeof input.command === "string") detail = input.command.slice(0, 64);
      else if (typeof input.description === "string") detail = input.description.slice(0, 64);
      else {
        const pth = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query;
        if (typeof pth === "string") detail = pth.replace(/\\/g, "/").split("/").pop()!.slice(0, 64);
      }
      out.push({ role: "tool", text: `${String((p as Record<string, unknown>).name)}${detail ? ` · ${detail}` : ""}` });
    }
  }
  // merge consecutive identical tool lines
  return out.filter((m, i) => !(m.role === "tool" && out[i - 1]?.role === "tool" && out[i - 1].text === m.text));
}

type CardNode = Node<{ ctx: Ctx; view: NodeView }, "chat" | "simple">;

function ChatCard({ data }: NodeProps<CardNode>) {
  const { ctx, view: v } = data;
  const addr = v.addr;
  const key = addr.item ? `${addr.item.foreach}/${addr.item.id}:${addr.node}` : addr.node;
  const draftKey = `flowy-draft:${ctx.state.dir}:${addr.node}`;
  const [msgs, setMsgs] = useState<ChatMsg[] | null>(null);
  const [draft, setDraftRaw] = useState<string>(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const setDraft = (v: string) => {
    setDraftRaw(v);
    try {
      if (v) localStorage.setItem(draftKey, v);
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage unavailable */
    }
  };
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(v.model ?? "");
  const [stance, setStance] = useState<string>(v.permissions ?? "ask");
  const [perms, setPerms] = useState<Array<{ id: string; tool: string; detail: string }>>([]);
  const [branching, setBranching] = useState(false);
  const [branchName, setBranchName] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const runId = ctx.state.overview?.run.id;

  useEffect(() => {
    let live = true;
    get<{ trace: TraceEvent[] }>("/api/node", { run: runId, ...addrParams(addr) })
      .then((d) => live && setMsgs(traceToMessages(d.trace)))
      .catch(() => live && setMsgs([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runId, ctx.refreshKey]);

  useEffect(() => {
    const onEvent = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { addr: NodeAddr; event: TraceEvent };
      const dk = d.addr.item ? `${d.addr.item.foreach}/${d.addr.item.id}:${d.addr.node}` : d.addr.node;
      if (dk !== key) return;
      setMsgs((cur) => [...(cur ?? []), ...traceToMessages([d.event])]);
    };
    window.addEventListener("flowy:chat-event", onEvent);
    return () => window.removeEventListener("flowy:chat-event", onEvent);
  }, [key]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs, perms]);

  // permission requests: this chat wants to use a tool outside its allowlist
  useEffect(() => {
    const onPerm = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { id: string; addr: NodeAddr; tool: string; input: Record<string, unknown> };
      const dk = d.addr.item ? `${d.addr.item.foreach}/${d.addr.item.id}:${d.addr.node}` : d.addr.node;
      if (dk !== key) return;
      const input = d.input ?? {};
      const detail = String(input.query ?? input.command ?? input.url ?? input.prompt ?? input.file_path ?? input.path ?? "").slice(0, 120);
      setPerms((cur) => [...cur, { id: d.id, tool: d.tool, detail }]);
    };
    const onDone = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { id: string };
      setPerms((cur) => cur.filter((p) => p.id !== d.id));
    };
    window.addEventListener("flowy:perm", onPerm);
    window.addEventListener("flowy:perm-done", onDone);
    return () => {
      window.removeEventListener("flowy:perm", onPerm);
      window.removeEventListener("flowy:perm-done", onDone);
    };
  }, [key]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      // Never clear what the human typed until the turn actually succeeded.
      await post("/api/chat-message", {
        run: runId,
        node: addr.node,
        item: addr.item ? `${addr.item.foreach}/${addr.item.id}` : undefined,
        text,
        model: model || undefined,
        permissions: stance !== "ask" ? stance : undefined,
      });
      setDraft("");
    } catch (e) {
      ctx.onError(`your message is still in the box — ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const branch = async () => {
    const id = branchName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id) return;
    setBranching(false);
    setBranchName("");
    await ctx.act(async () => {
      await post("/api/graph/node", { id, mode: "chat", title: branchName.trim(), continues: addr.node });
      const me = ctx.state.layout?.nodes.find((n) => n.id === addr.node);
      await post("/api/layout", { positions: { [id]: { x: (me?.x ?? 300) + 420, y: (me?.y ?? 100) + 60 } } });
    });
  };

  const yours = NEEDS_YOU.includes(v.status) || WRONG.includes(v.status);

  return (
    <div className={`card chat-card ${yours && v.status !== "waiting" ? "yours" : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className="chat-head">
        <span className="hand" style={{ fontSize: 17 }}>
          {v.title}
        </span>
        <span className="muted small">
          {v.recipe ? "knows the recipe" : v.continues ? `branch of ${v.continues}` : ""}
          {v.result?.cost_usd ? ` · ≈$${v.result.cost_usd.toFixed(2)}` : ""}
        </span>
      </div>
      <div ref={scroller} className="bubbles nowheel nodrag">
        {msgs === null && <div className="muted small">…</div>}
        {msgs !== null && msgs.length === 0 && <div className="muted small">{v.brief ? "say something to start — it knows its brief" : "say something to start"}</div>}
        {(msgs ?? []).map((m, i) =>
          m.role === "tool" ? (
            <div key={i} className="tool-line">
              ⚙ {m.text}
            </div>
          ) : m.role === "assistant" ? (
            <div key={i} className="bubble assistant md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
          ) : (
            <div key={i} className={`bubble ${m.role}`}>
              {m.text}
            </div>
          ),
        )}
        {perms.map((p) => (
          <div key={p.id} className="perm-ask">
            <div className="perm-text">
              wants to use <strong>{p.tool.replace(/^mcp__[^_]+__/, "")}</strong>
              {p.detail ? ` — ${p.detail}` : ""}
            </div>
            <div className="perm-buttons">
              <button className="primary" onClick={() => void post("/api/perm/answer", { id: p.id, behavior: "allow" })}>
                allow
              </button>
              <button className="ghost" onClick={() => void post("/api/perm/answer", { id: p.id, behavior: "deny" })}>
                deny
              </button>
            </div>
          </div>
        ))}
        {busy && perms.length === 0 && <div className="tool-line">thinking…</div>}
      </div>
      <div className="chat-input nodrag nowheel">
        <textarea
          rows={1}
          placeholder={busy ? "…" : "talk to it"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="ghost" disabled={busy || !draft.trim()} onClick={() => void send()} title="send (Enter)">
          <Play size={13} />
        </button>
      </div>
      <div className="chat-actions nodrag">
        <button className="ghost small" disabled={!v.result?.session_id || busy} onClick={() => ctx.act(() => post("/api/crystallize", { run: runId, node: addr.node, item: addr.item ? `${addr.item.foreach}/${addr.item.id}` : undefined }))} title="distill this conversation into the recipe — next time it runs alone">
          <Pencil size={12} /> {v.recipe ? "update recipe" : "create recipe"}
        </button>
        <button className="ghost small" disabled={!v.result?.session_id} onClick={() => setBranching((b) => !b)} title="a new chat that remembers this whole conversation">
          ⑂ branch
        </button>
        <span className="grow" />
        <select
          className="model-select"
          value={stance}
          onChange={(e) => {
            const val = e.target.value;
            setStance(val);
            void post("/api/graph/node", { op: "update", id: addr.node, fields: { permissions: val === "ask" ? null : val } }).catch((err) => ctx.onError((err as Error).message));
          }}
          title="when this chat asks before using tools"
        >
          <option value="ask">ask: new things</option>
          <option value="ask-all">ask: everything</option>
          <option value="allow-all">ask: never</option>
        </select>
        <select
          className="model-select"
          value={model}
          onChange={(e) => {
            const val = e.target.value;
            setModel(val);
            // persist into the node file so replays and recipes use it too
            void post("/api/graph/node", { op: "update", id: addr.node, fields: { model: val || null } }).catch((err) => ctx.onError((err as Error).message));
          }}
          title="which model this chat talks to (applies to the next message)"
        >
          <option value="">model: default</option>
          <option value="claude-fable-5">fable</option>
          <option value="opus">opus</option>
          <option value="sonnet">sonnet</option>
          <option value="haiku">haiku</option>
          {model && !["", "claude-fable-5", "opus", "sonnet", "haiku"].includes(model) && <option value={model}>{model}</option>}
        </select>
      </div>
      {branching && (
        <div className="chat-input nodrag">
          <input autoFocus placeholder="name the branch…" value={branchName} onChange={(e) => setBranchName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void branch()} />
          <button className="ghost" onClick={() => void branch()} disabled={!branchName.trim()}>
            <Check size={13} />
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/* ---------------- simple / pill / checklist cards ---------------- */

function SimpleCard({ data }: NodeProps<CardNode>) {
  const { ctx, view: v } = data;
  const yours = NEEDS_YOU.includes(v.status);
  const wrong = WRONG.includes(v.status);
  return (
    <div className={`card step-card ${yours || wrong ? "yours" : ""} ${v.status === "pending" && !v.version ? "dim" : ""}`} onClick={() => ctx.onOpen({ kind: "step", addr: v.addr })}>
      {(yours || wrong) && <div className="yourturn-label">{wrong ? "look at this" : "your turn"}</div>}
      <Handle type="target" position={Position.Left} />
      <div className="title">
        <span>{v.title}</span>
        {v.status === "done" && <Check size={18} />}
        {v.status === "running" && <span className="dots">···</span>}
      </div>
      <div className="sub">
        {humanMode(v.mode, v.recipe)}
        {v.result?.duration_ms ? ` · ${Math.round(v.result.duration_ms / 1000)}s` : ""}
        {v.status === "stale" ? " · needs a refresh" : ""}
      </div>
      {(yours || wrong) && <div className="note">{wrong ? "went wrong — open it" : (v.hint ?? "your call — open it")}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type PillNode = Node<{ label: string; sub: string; unattached?: boolean; out?: boolean; onPreview?: () => void }, "pill">;

function PillCard({ data }: NodeProps<PillNode>) {
  return (
    <div className="card wob2 source-card" style={{ cursor: data.onPreview ? "pointer" : undefined, ...(data.unattached ? { borderStyle: "dashed" as const } : {}) }} onClick={() => data.onPreview?.()}>
      {data.out && <Handle type="target" position={Position.Left} />}
      <div className="name">
        {data.out ? <FileIcon size={15} /> : <Folder />} <span>{data.label}</span>
      </div>
      <div className="sub">{data.unattached ? "draw an arrow to a chat" : data.sub}</div>
      {!data.out && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

type FeNode = Node<{ ctx: Ctx; fe: ForeachView }, "checklist">;

function ChecklistCard({ data }: NodeProps<FeNode>) {
  const { ctx, fe } = data;
  return (
    <div className="card wob2 checklist-card">
      <Handle type="target" position={Position.Left} />
      <div className="head" onClick={() => ctx.onOpen({ kind: "checklist", foreach: fe.id })}>
        <span className="title">{fe.id}</span>
        <span className="muted small">checklist</span>
      </div>
      {fe.items.length === 0 && <div className="empty">the list appears when the step it reads from finishes</div>}
      {fe.items.map((it) => {
        const w = itemWorst(it);
        const parked = it.state === "skipped" || it.state === "orphaned";
        const hot = w.view && (NEEDS_YOU.includes(w.view.status) || WRONG.includes(w.view.status));
        return (
          <div key={it.id} className={`check-row ${hot ? "yours" : ""}`} onClick={() => (hot && w.view ? ctx.onOpen({ kind: "step", addr: w.view.addr }) : ctx.onOpen({ kind: "item", foreach: fe.id, id: it.id }))}>
            <Box checked={w.status === "done"} accent={!!hot} dashed={parked || w.status === "working"} />
            <div className={`name ${parked ? "strike muted" : ""}`}>{it.id}</div>
            <span className="state">{w.status === "working" ? <span className="dots">···</span> : w.status === "done" ? "" : w.status}</span>
          </div>
        );
      })}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { chat: ChatCard, simple: SimpleCard, pill: PillCard, checklist: ChecklistCard };

/* ---------------- the canvas ---------------- */

function Canvas({ state, onOpen, onError, act }: { state: State; onOpen: (t: OpenTarget) => void; onError: (msg: string) => void; act: Ctx["act"] }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const sketchRef = useRef<Sketch>({ elements: [], sources: {}, unattached: [] });
  const [sketchLoaded, setSketchLoaded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ title: string; params: Record<string, string | undefined> } | null>(null);
  const rf = useReactFlow();
  const sketchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveSketch = useCallback(() => {
    if (sketchTimer.current) clearTimeout(sketchTimer.current);
    sketchTimer.current = setTimeout(() => void post("/api/sketch", sketchRef.current as unknown as Record<string, unknown>).catch(() => {}), 800);
  }, []);

  useEffect(() => {
    get<Sketch>("/api/sketch")
      .then((s) => {
        sketchRef.current = { elements: [], sources: s.sources ?? {}, unattached: s.unattached ?? [] };
        setSketchLoaded(true);
      })
      .catch(() => setSketchLoaded(true));
  }, []);

  const ctx: Ctx = useMemo(
    () => ({ state, onOpen, onError, act, sketch: () => sketchRef.current, saveSketch, refreshKey }),
    [state, onOpen, onError, act, saveSketch, refreshKey],
  );

  const sources = useMemo(() => (state.manifest ? collectSources(state.manifest) : []), [state.manifest]);

  const built = useMemo(() => {
    const m = state.manifest;
    if (!m || !sketchLoaded) return { nodes: [] as Node[], edges: [] as Edge[] };
    const ov = state.overview;
    const pos = new Map((state.layout?.nodes ?? []).map((n) => [n.id, { x: n.x, y: n.y }]));
    const viewById = new Map((ov?.nodes ?? []).map((n) => [n.id, n]));
    const feById = new Map((ov?.foreach ?? []).map((f) => [f.id, f]));
    const ns: Node[] = [];
    const es: Edge[] = [];

    for (const [i, id] of m.top.entries()) {
      const p = pos.get(id) ?? { x: 420, y: i * 240 };
      if (id in m.foreach) {
        const fe = feById.get(id) ?? { id, source: `${m.foreach[id].source.node}.${m.foreach[id].source.key}`, expanded: false, items: [], needs: m.foreach[id].needs, nodes: m.foreach[id].nodes };
        ns.push({ id, type: "checklist", position: p, data: { ctx, fe } });
      } else {
        const view = viewById.get(id) ?? placeholderView(m, id);
        ns.push({ id, type: view.mode === "chat" ? "chat" : "simple", position: p, data: { ctx, view } });
      }
    }

    sources.forEach((s, i) => {
      const first = ns.find((n) => s.targets.some((t) => t.id === n.id));
      const saved = sketchRef.current.sources[s.key];
      const p = saved ?? { x: (first?.position.x ?? 400) - 300, y: (first?.position.y ?? 40) + i * 96 };
      const entry = s.targets[0]?.entry ?? s.key;
      const previewable = !entry.includes("{{");
      ns.push({
        id: `src-${i}`,
        type: "pill",
        position: p,
        data: { label: s.label, sub: s.sub, onPreview: previewable ? () => setPreview({ title: s.label, params: { path: entry } }) : () => onError("this path is filled in by a run input") },
      });
      for (const t of s.targets) {
        es.push({
          id: `c-${i}--${t.id}`,
          source: `src-${i}`,
          target: t.id,
          style: { strokeDasharray: "6 6", opacity: 0.5 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: "#8a857c" },
        });
      }
    });

    (sketchRef.current.unattached ?? []).forEach((p2, i) => {
      const saved = sketchRef.current.sources[`u:${p2}`];
      ns.push({
        id: `usrc-${i}`,
        type: "pill",
        position: saved ?? { x: 60, y: 60 + i * 96 },
        data: { label: p2.split(/[\\/]/).pop() ?? p2, sub: "", unattached: true, onPreview: () => setPreview({ title: p2.split(/[\\/]/).pop() ?? p2, params: { path: p2 } }) },
      });
    });

    // outputs become pills, with the arrow coming FROM the chat that made them
    for (const n of [...ns]) {
      if (n.type !== "chat" && n.type !== "simple") continue;
      const view = (n.data as { view?: NodeView }).view;
      if (!view?.result) continue;
      const files = Object.keys(view.result.outputs).filter((f) => !f.startsWith("_"));
      files.slice(0, 6).forEach((f, j) => {
        const skey = `o:${n.id}/${f}`;
        const saved = sketchRef.current.sources[skey];
        const pid = `out-${n.id}--${j}`;
        ns.push({
          id: pid,
          type: "pill",
          position: saved ?? { x: n.position.x + 440, y: n.position.y + j * 84 },
          data: {
            label: f.split("/").pop() ?? f,
            sub: "result",
            out: true,
            sketchKey: skey,
            onPreview: () =>
              setPreview({
                title: f.split("/").pop() ?? f,
                params: { run: ov?.run.id, node: n.id, file: f, item: undefined },
              }),
          } as PillNode["data"] & { sketchKey: string },
        });
        es.push({ id: `oe-${n.id}--${j}`, source: n.id, target: pid, style: { opacity: 0.55 }, markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "#8a857c" } });
      });
    }

    const topSet = new Set(m.top);
    const seen = new Set<string>();
    for (const e of m.edges) {
      if (!topSet.has(e.from) || !topSet.has(e.to)) continue;
      const id = `e-${e.from}--${e.to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const branch = m.nodes[e.to]?.continues === e.from;
      es.push({
        id,
        source: e.from,
        target: e.to,
        label: branch ? "⑂ remembers" : undefined,
        className: viewById.get(e.from)?.status === "running" ? "running" : "",
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: "#2b2925" },
      });
    }
    return { nodes: ns, edges: es };
  }, [state, sources, ctx, sketchLoaded]);

  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
    setRefreshKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [built.nodes.length, built.edges.length, state]);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (node.id.startsWith("src-")) {
        const s = sources[parseInt(node.id.slice(4), 10)];
        if (s) {
          sketchRef.current.sources[s.key] = node.position;
          saveSketch();
        }
      } else if (node.id.startsWith("usrc-")) {
        const p = (sketchRef.current.unattached ?? [])[parseInt(node.id.slice(5), 10)];
        if (p) {
          sketchRef.current.sources[`u:${p}`] = node.position;
          saveSketch();
        }
      } else if (node.id.startsWith("out-")) {
        const skey = (node.data as { sketchKey?: string }).sketchKey;
        if (skey) {
          sketchRef.current.sources[skey] = node.position;
          saveSketch();
        }
      } else void post("/api/layout", { positions: { [node.id]: node.position } }).catch((e) => onError(e.message));
    },
    [sources, saveSketch, onError],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const m = state.manifest;
      if (!m || !c.source || !c.target) return;
      if (c.target.startsWith("src-") || c.target.startsWith("usrc-")) return;
      if (c.source.startsWith("src-")) {
        const s = sources[parseInt(c.source.slice(4), 10)];
        if (s) void act(() => post("/api/graph/context", { op: "add", node: c.target, entry: entryFor(s, c.target, m) }));
      } else if (c.source.startsWith("usrc-")) {
        const p = (sketchRef.current.unattached ?? [])[parseInt(c.source.slice(5), 10)];
        if (p)
          void act(async () => {
            await post("/api/graph/context", { op: "add", node: c.target, entry: relativeEntry(p, state.dir) });
            sketchRef.current.unattached = (sketchRef.current.unattached ?? []).filter((x) => x !== p);
            saveSketch();
          });
      } else void act(() => post("/api/graph/edge", { op: "add", from: c.source, to: c.target }));
    },
    [state.manifest, state.dir, sources, act, saveSketch],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      const cards = deleted.filter((n) => !n.id.startsWith("src-") && !n.id.startsWith("usrc-") && !n.id.startsWith("out-"));
      const usrcs = deleted.filter((n) => n.id.startsWith("usrc-"));
      const srcs = deleted.filter((n) => n.id.startsWith("src-"));
      void (async () => {
        if (usrcs.length) {
          const paths = usrcs.map((n) => (sketchRef.current.unattached ?? [])[parseInt(n.id.slice(5), 10)]).filter(Boolean);
          sketchRef.current.unattached = (sketchRef.current.unattached ?? []).filter((p) => !paths.includes(p));
          saveSketch();
        }
        for (const n of srcs) {
          const s = sources[parseInt(n.id.slice(4), 10)];
          if (s && window.confirm(`Detach "${s.label}" from ${s.targets.map((t) => t.id).join(", ")}?`)) {
            for (const t of s.targets) await post("/api/graph/context", { op: "remove", node: t.id, entry: t.entry }).catch((e) => onError(e.message));
          }
        }
        if (cards.length) {
          if (window.confirm(`Delete ${cards.map((n) => `"${n.id}"`).join(", ")}?\n\nAnything that referenced them adapts. Past runs stay on disk.`)) {
            for (const n of cards)
              await post("/api/graph/node", { op: "remove", id: n.id }).catch((e) => {
                if (!/unknown node/.test(String(e.message))) onError(e.message);
              });
          }
        }
        await act(async () => {});
      })();
    },
    [sources, saveSketch, onError, act],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      void (async () => {
        for (const e of deleted) {
          if (e.id.startsWith("e-")) {
            const [from, to] = e.id.slice(2).split("--");
            await post("/api/graph/edge", { op: "remove", from, to }).catch((err) => onError(err.message));
          } else if (e.id.startsWith("c-")) {
            const [idxS, node] = e.id.slice(2).split("--");
            const s = sources[parseInt(idxS, 10)];
            const entry = s?.targets.find((t) => t.id === node)?.entry;
            if (entry) await post("/api/graph/context", { op: "remove", node, entry }).catch((err) => onError(err.message));
          }
        }
        await act(async () => {});
      })();
    },
    [sources, onError, act],
  );

  // header buttons
  useEffect(() => {
    const addChat = () => {
      setName("");
      setNaming(true);
    };
    const addSource = (ev: Event) => {
      const p = (ev as CustomEvent).detail?.path as string | undefined;
      if (!p) return onError("could not open the file picker");
      const list = sketchRef.current.unattached ?? [];
      if (!list.includes(p)) {
        sketchRef.current.unattached = [...list, p];
        saveSketch();
        setRefreshKey((k) => k + 1);
        void act(async () => {});
      }
    };
    window.addEventListener("flowy:add-step", addChat);
    window.addEventListener("flowy:add-source", addSource);
    return () => {
      window.removeEventListener("flowy:add-step", addChat);
      window.removeEventListener("flowy:add-source", addSource);
    };
  }, [act, onError, saveSketch]);

  const createChat = async () => {
    const id = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id) return;
    setNaming(false);
    const center = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    await act(async () => {
      await post("/api/graph/node", { id, mode: "chat", title: name.trim() });
      await post("/api/layout", { positions: { [id]: { x: center.x - 170, y: center.y - 100 } } });
    });
  };

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        deleteKeyCode="Delete"
        fitView
        minZoom={0.15}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#ddd9d0" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="canvas-hint">arrows connect · Delete removes · drag anything · click a pill to peek</div>
      {preview && <PreviewPaper title={preview.title} params={preview.params} onClose={() => setPreview(null)} onError={onError} />}
      {naming && (
        <div className="overlay" onClick={() => setNaming(false)}>
          <div className="paper" style={{ width: 400, marginTop: 60 }} onClick={(e) => e.stopPropagation()}>
            <h1>new chat</h1>
            <div className="sub">a conversation with Claude, on this canvas — teach it once, then make it a recipe</div>
            <label>
              <span>what is it about?</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void createChat()} placeholder="e.g. pick the hooks" />
            </label>
            <div className="actions">
              <button className="primary" onClick={() => void createChat()} disabled={!name.trim()}>
                <Play size={12} color="#fffdf9" /> create
              </button>
              <button className="ghost" onClick={() => setNaming(false)}>
                never mind
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PreviewPaper({ title, params, onClose, onError }: { title: string; params: Record<string, string | undefined>; onClose: () => void; onError: (m: string) => void }) {
  const [data, setData] = useState<{ text?: string; path?: string; binary?: boolean; bytes?: number; dir?: boolean; entries?: string[] } | null>(null);
  useEffect(() => {
    post<typeof data>("/api/preview", params as Record<string, unknown>)
      .then(setData)
      .catch((e) => {
        onError((e as Error).message);
        onClose();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isMd = /\.(md|markdown)$/i.test(title);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="paper" onClick={(e) => e.stopPropagation()}>
        <h1>{title}</h1>
        {data?.path && <div className="pathline">{data.path}</div>}
        {!data && <div className="muted small">…</div>}
        {data?.dir && (
          <pre style={{ maxHeight: 380 }}>{(data.entries ?? []).join("\n")}</pre>
        )}
        {data?.binary && <div className="muted">binary file · {Math.round((data.bytes ?? 0) / 1024)} KB</div>}
        {data?.text !== undefined &&
          (isMd ? <div className="md preview-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.text ?? "") }} /> : <pre style={{ maxHeight: 420 }}>{data.text}</pre>)}
        <div className="actions">
          {data?.path && (
            <button className="ghost" onClick={() => post("/api/reveal", { path: data.path }).catch((e) => onError((e as Error).message))}>
              <Folder size={15} /> show in Explorer
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}

export function FlowCanvas(props: { state: State; onOpen: (t: OpenTarget) => void; onError: (msg: string) => void; act: Ctx["act"] }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
