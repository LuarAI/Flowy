import { useCallback, useEffect, useMemo } from "react";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, useEdgesState, useNodesState, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { fmtBytes, type ForeachView, type ItemView, type Manifest, type NodeAddr, type NodeView, type State } from "./client";
import { Check, Folder, FileIcon, Box } from "./icons";

/* ---------- status helpers ---------- */

const NEEDS_YOU = ["gate", "waiting"];
const WRONG = ["failed", "blocked", "missing_output", "schema_invalid", "timeout", "interrupted"];

export function humanMode(mode: string, recipe?: boolean): string {
  if (mode === "chat") return recipe ? "knows the recipe" : "you + Claude, first time";
  return mode === "agent" ? "Claude does it" : mode === "wait" ? "you do it" : "runs a tool";
}

export function humanStatus(v: NodeView): string {
  switch (v.status) {
    case "done":
      return "done";
    case "running":
      return "working";
    case "gate":
      return "your call";
    case "waiting":
      return v.mode === "chat" ? "talk it through" : "waiting on you";
    case "stale":
      return "needs a refresh";
    case "pending":
      return "up next";
    case "skipped":
      return "parked";
    default:
      return WRONG.includes(v.status) ? "went wrong" : v.status;
  }
}

export function itemWorst(it: ItemView): { status: string; view: NodeView | null } {
  if (it.state === "skipped" || it.state === "orphaned") return { status: "parked", view: null };
  const order = [...WRONG, "gate", "waiting", "running", "stale", "pending", "done"];
  let worst: NodeView | null = null;
  for (const n of it.nodes) {
    if (!worst || order.indexOf(n.status) < order.indexOf(worst.status)) worst = n;
  }
  return { status: worst ? humanStatus(worst) : "up next", view: worst };
}

export function dotColor(status: string): string {
  if (["gate", "waiting", "your call", "waiting on you", "talk it through", "went wrong", ...WRONG].includes(status)) return "var(--accent)";
  if (["done"].includes(status)) return "#4c8a4f";
  if (["running", "working"].includes(status)) return "var(--ink)";
  return "var(--faint)";
}

/* ---------- card components ---------- */

type StepData = { view: NodeView; onOpen: (a: NodeAddr) => void };
type StepNode = Node<StepData, "step">;

function StepCard({ data }: NodeProps<StepNode>) {
  const v = data.view;
  const yours = NEEDS_YOU.includes(v.status);
  const wrong = WRONG.includes(v.status);
  const dim = v.status === "pending" && !v.version;
  const files = v.result ? Object.keys(v.result.outputs).filter((f) => !f.startsWith("_")) : [];
  return (
    <div className={`card step-card ${dim ? "dim" : ""} ${yours || wrong ? "yours" : ""}`} onClick={() => data.onOpen(v.addr)}>
      {(yours || wrong) && <div className="yourturn-label">{wrong ? "look at this" : "your turn"}</div>}
      <Handle type="target" position={Position.Top} />
      <div className="title">
        <span>{v.title}</span>
        {v.status === "done" && <Check size={19} />}
        {v.status === "running" && <span className="dots">···</span>}
      </div>
      <div className="sub">
        {humanMode(v.mode, v.recipe)}
        {v.result?.duration_ms ? ` · ${Math.round(v.result.duration_ms / 1000)}s` : ""}
        {v.status === "stale" ? " · needs a refresh" : ""}
      </div>
      {yours && <div className="note">{v.hint ?? (v.status === "gate" ? "your call — open it" : "waiting for your files")}</div>}
      {wrong && <div className="note">went wrong — open it</div>}
      {v.status === "done" && files.length > 0 && (
        <div className="chips">
          {files.slice(0, 3).map((f) => (
            <span key={f} className="chip">
              <FileIcon /> {f.split("/").pop()}
            </span>
          ))}
          {files.length > 3 && <span className="chip faint">+{files.length - 3}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

type SourceData = { label: string; sub: string };
type SourceNode = Node<SourceData, "source">;

function SourceCard({ data }: NodeProps<SourceNode>) {
  return (
    <div className="card wob2 source-card">
      <div className="name">
        <Folder /> <span>{data.label}</span>
      </div>
      <div className="sub">{data.sub}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

type ChecklistData = { fe: ForeachView; title: string; onOpenItem: (fe: string, id: string) => void; onOpen: (a: NodeAddr) => void };
type ChecklistNode = Node<ChecklistData, "checklist">;

function ChecklistCard({ data }: NodeProps<ChecklistNode>) {
  const { fe } = data;
  const counts: Record<string, number> = {};
  for (const it of fe.items) {
    const w = itemWorst(it).status;
    counts[w] = (counts[w] ?? 0) + 1;
  }
  return (
    <div className="card wob2 checklist-card">
      <Handle type="target" position={Position.Top} />
      <div className="head">
        <span className="title">{data.title}</span>
        <span className="muted small">
          {fe.items.length === 0
            ? "checklist"
            : Object.entries(counts)
                .map(([k, n]) => `${n} ${k}`)
                .join(" · ")}
        </span>
      </div>
      {fe.items.length === 0 && <div className="empty">the list appears when the step above finishes</div>}
      {fe.items.map((it) => {
        const w = itemWorst(it);
        const parked = it.state === "skipped" || it.state === "orphaned";
        const yours = w.view && NEEDS_YOU.includes(w.view.status);
        const wrong = w.view && WRONG.includes(w.view.status);
        return (
          <div
            key={it.id}
            className={`check-row ${yours || wrong ? "yours" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if ((yours || wrong) && w.view) data.onOpen(w.view.addr);
              else data.onOpenItem(fe.id, it.id);
            }}
          >
            <Box checked={w.status === "done"} accent={!!yours || !!wrong} dashed={parked || w.status === "working" || w.status === "up next"} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={`name ${parked ? "strike muted" : ""}`}>{it.id}</div>
              {(yours || wrong) && w.view && (
                <div className="why">
                  {wrong ? "went wrong" : "your call"} — {w.view.title.toLowerCase()}
                </div>
              )}
            </div>
            <span className="state">{w.status === "working" ? <span className="dots">···</span> : w.status === "done" ? "" : w.status}</span>
          </div>
        );
      })}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { step: StepCard, source: SourceCard, checklist: ChecklistCard };

/* ---------- sources derived from the manifest ---------- */

function sourceLabel(entry: string): { label: string; sub: string } {
  const clean = entry.replace(/\{\{\s*inputs\.([a-z_]+)\s*\}\}/g, "<$1>");
  const parts = clean.split("/").filter(Boolean);
  return { label: parts[parts.length - 1] ?? clean, sub: parts.length > 1 ? parts.slice(0, -1).join("/") : "source" };
}

function collectSources(m: Manifest): Array<{ id: string; label: string; sub: string; targets: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const n of Object.values(m.nodes)) {
    const target = n.foreach ?? n.id;
    for (const c of (n as { context?: string[] }).context ?? []) {
      if (!map.has(c)) map.set(c, new Set());
      map.get(c)!.add(target);
    }
  }
  return [...map.entries()].map(([entry, targets], i) => ({ id: `src-${i}`, ...sourceLabel(entry), targets: [...targets] }));
}

/* ---------- the canvas ---------- */

interface Props {
  state: State;
  onOpen: (a: NodeAddr) => void;
  onOpenItem: (fe: string, id: string) => void;
  onMove: (positions: Record<string, { x: number; y: number }>) => void;
}

export function Canvas({ state, onOpen, onOpenItem, onMove }: Props) {
  const { manifest: m, layout, overview: ov } = state;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  const built = useMemo(() => {
    if (!m) return { nodes: [] as Node[], edges: [] as Edge[] };
    const pos = new Map((layout?.nodes ?? []).map((n) => [n.id, n]));
    const viewById = new Map((ov?.nodes ?? []).map((n) => [n.id, n]));
    const feById = new Map((ov?.foreach ?? []).map((f) => [f.id, f]));
    const ns: Node[] = [];
    const es: Edge[] = [];

    for (const [i, id] of m.top.entries()) {
      const p = pos.get(id);
      const position = { x: p?.x ?? 320, y: p?.y ?? i * 180 };
      if (id in m.foreach) {
        const fe = feById.get(id) ?? { id, source: `${m.foreach[id].source.node}.${m.foreach[id].source.key}`, expanded: false, items: [], needs: m.foreach[id].needs, nodes: m.foreach[id].nodes };
        ns.push({ id, type: "checklist", position, data: { fe, title: id, onOpenItem, onOpen } });
      } else {
        const view = viewById.get(id) ?? placeholderView(m, id);
        ns.push({ id, type: "step", position, data: { view, onOpen } });
      }
    }

    // sources on the left of their first consumer
    const srcs = collectSources(m);
    const stacks = new Map<string, number>();
    for (const s of srcs) {
      const first = ns.find((n) => s.targets.includes(n.id));
      const bx = (first?.position.x ?? 300) - 280;
      const key = String(first?.id ?? "x");
      const row = stacks.get(key) ?? 0;
      stacks.set(key, row + 1);
      ns.push({ id: s.id, type: "source", position: { x: bx - row * 16, y: (first?.position.y ?? 0) + row * 96 }, data: { label: s.label, sub: s.sub }, draggable: true });
      for (const t of s.targets) {
        es.push({ id: `${s.id}->${t}`, source: s.id, target: t, style: { strokeDasharray: "6 6", opacity: 0.55 }, markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#8a857c" } });
      }
    }

    const topSet = new Set(m.top);
    const seen = new Set<string>();
    for (const e of m.edges) {
      if (!topSet.has(e.from) || !topSet.has(e.to)) continue;
      const id = `${e.from}->${e.to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const from = viewById.get(e.from);
      const bytes = from?.result ? Object.values(from.result.outputs).reduce((a, o) => a + o.bytes, 0) : 0;
      es.push({
        id,
        source: e.from,
        target: e.to,
        className: from?.status === "running" ? "running" : "",
        label: bytes ? fmtBytes(bytes) : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color: "#2b2925" },
      });
    }
    return { nodes: ns, edges: es };
  }, [m, layout, ov, onOpen, onOpenItem]);

  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (!node.id.startsWith("src-")) onMove({ [node.id]: node.position });
    },
    [onMove],
  );

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        nodesConnectable={false}
        deleteKeyCode={null}
        fitView
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#ddd9d0" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="canvas-hint">drag anything · click a card to open it</div>
    </>
  );
}

function placeholderView(m: Manifest, id: string): NodeView {
  const n = m.nodes[id];
  return {
    addr: { node: id },
    id,
    title: n?.title ?? id,
    mode: (n?.mode as NodeView["mode"]) ?? "agent",
    engine: "",
    status: "pending",
    version: null,
    versions: [],
    result: null,
    approval: null,
    gate: !!n?.approve,
    staleReasons: [],
    hint: null,
    lock: n?.lock ?? null,
    needs: n?.needs ?? [],
    outputs: n?.outputs ?? [],
    approveFields: null,
    recipe: n?.recipe ?? false,
    continues: n?.continues ?? null,
  };
}
