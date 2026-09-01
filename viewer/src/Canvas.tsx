import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { fmtBytes, fmtCost, STATUS_COLORS, type ForeachView, type NodeAddr, type NodeView, type State } from "./client";

type FlowyData = {
  kind: "node" | "foreach";
  view?: NodeView;
  fe?: ForeachView;
  label: string;
  sub: string;
  selectedItem?: string | null;
  onSelectItem?: (fe: string, id: string) => void;
};
type FlowyNode = Node<FlowyData, "flowy">;

function FlowyNodeCard({ data, selected }: NodeProps<FlowyNode>) {
  if (data.kind === "foreach" && data.fe) {
    const fe = data.fe;
    const counts = fe.items.reduce<Record<string, number>>((acc, it) => ((acc[it.state] = (acc[it.state] ?? 0) + 1), acc), {});
    return (
      <div className={`card foreach ${selected ? "selected" : ""}`}>
        <Handle type="target" position={Position.Top} />
        <div className="card-head">
          <span className="badge" style={{ background: "var(--c-blue)" }}>
            foreach
          </span>
          <strong>{fe.id}</strong>
          <span className="muted small">{fe.source}</span>
        </div>
        <div className="muted small">{fe.nodes.join(" → ")}</div>
        {fe.items.length === 0 ? (
          <div className="muted small">no items yet</div>
        ) : (
          <div className="items">
            {fe.items.map((it) => {
              const worst = itemStatus(it.state, it.nodes);
              return (
                <div
                  key={it.id}
                  className={`item ${data.selectedItem === it.id ? "selected" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    data.onSelectItem?.(fe.id, it.id);
                  }}
                  title={`${it.id}: ${worst}`}
                >
                  <span className="dot" style={{ background: STATUS_COLORS[worst] ?? "var(--c-muted)" }} />
                  <span className={it.state === "skipped" || it.state === "orphaned" ? "strike" : ""}>{it.id}</span>
                  <span className="muted small grow-r">{worst}</span>
                  {it.cost > 0 && <span className="muted small">{fmtCost(it.cost)}</span>}
                </div>
              );
            })}
          </div>
        )}
        <div className="muted small">
          {Object.entries(counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(" · ")}
        </div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  }
  const v = data.view!;
  const color = STATUS_COLORS[v.status] ?? "var(--c-muted)";
  return (
    <div className={`card ${selected ? "selected" : ""}`} style={{ borderColor: color }}>
      <Handle type="target" position={Position.Top} />
      <div className="card-head">
        <span className="badge" style={{ background: color }}>
          {v.status}
        </span>
        <strong>{v.id}</strong>
      </div>
      <div className="muted small">
        {v.mode}
        {v.gate ? " · gate" : ""}
        {v.lock ? ` · lock ${v.lock}` : ""}
        {v.version ? ` · ${v.version}` : ""}
      </div>
      <div className="small row-between">
        <span>{fmtCost(v.result?.cost_usd)}</span>
        <span className="muted">{v.result?.duration_ms ? `${(v.result.duration_ms / 1000).toFixed(1)}s` : ""}</span>
      </div>
      {v.status === "stale" && <div className="small violet">{v.staleReasons.slice(0, 2).join(", ")}</div>}
      {v.status === "waiting" && v.hint && <div className="small amber">{v.hint}</div>}
      {v.result?.error && <div className="small red ellipsis">{v.result.error.split("\n")[0]}</div>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function itemStatus(state: string, nodes: NodeView[]): string {
  if (state === "skipped" || state === "orphaned") return state;
  const order = ["failed", "blocked", "missing_output", "schema_invalid", "timeout", "interrupted", "running", "gate", "waiting", "stale", "pending", "done"];
  let worst = "done";
  for (const n of nodes) {
    const s = n.status;
    if (order.indexOf(s) < order.indexOf(worst)) worst = s;
  }
  if (worst === "done" && nodes.some((n) => n.status !== "done")) worst = "pending";
  return worst;
}

const nodeTypes = { flowy: FlowyNodeCard };

interface Props {
  state: State;
  selected: NodeAddr | null;
  selectedItem: { foreach: string; id: string } | null;
  onSelect: (a: NodeAddr) => void;
  onSelectItem: (fe: string, id: string) => void;
  onMove: (positions: Record<string, { x: number; y: number }>) => void;
  onConnect: (from: string, to: string) => void;
  onRemoveEdge: (from: string, to: string) => void;
  onAddNode: (n: { id: string; mode: string; title?: string }) => void;
  onRemoveNode: (id: string) => void;
}

export function Canvas({ state, selected, selectedItem, onSelect, onSelectItem, onMove, onConnect, onRemoveEdge, onAddNode, onRemoveNode }: Props) {
  const { manifest: m, layout, overview: ov } = state;
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowyNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [editMode, setEditMode] = useState(false);

  const built = useMemo(() => {
    if (!m) return { nodes: [] as FlowyNode[], edges: [] as Edge[] };
    const pos = new Map((layout?.nodes ?? []).map((n) => [n.id, n]));
    const viewById = new Map((ov?.nodes ?? []).map((n) => [n.id, n]));
    const feById = new Map((ov?.foreach ?? []).map((f) => [f.id, f]));
    const ns: FlowyNode[] = m.top.map((id, i) => {
      const p = pos.get(id);
      const isFe = id in m.foreach;
      const view = isFe ? undefined : (viewById.get(id) ?? placeholderView(m, id));
      const fe = isFe ? (feById.get(id) ?? placeholderForeach(m, id)) : undefined;
      return {
        id,
        type: "flowy",
        position: { x: p?.x ?? 0, y: p?.y ?? i * 160 },
        data: isFe ? { kind: "foreach", fe, label: id, sub: "", selectedItem: selectedItem?.foreach === id ? selectedItem.id : null, onSelectItem } : { kind: "node", view, label: id, sub: "" },
        selected: !!selected && !selected.item && selected.node === id,
      };
    });
    const topSet = new Set(m.top);
    const es: Edge[] = [];
    const seen = new Set<string>();
    for (const e of m.edges) {
      if (!topSet.has(e.from) || !topSet.has(e.to)) continue;
      const id = `${e.from}->${e.to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const from = viewById.get(e.from);
      const bytes = from?.result ? Object.values(from.result.outputs).reduce((a, o) => a + o.bytes, 0) : 0;
      es.push({ id, source: e.from, target: e.to, label: bytes ? fmtBytes(bytes) : undefined, animated: from?.status === "running", deletable: editMode });
    }
    return { nodes: ns, edges: es };
  }, [m, layout, ov, selected, selectedItem, onSelectItem, editMode]);

  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
  }, [built, setNodes, setEdges]);

  const onNodeDragStop = useCallback(
    (_: unknown, node: FlowyNode) => {
      onMove({ [node.id]: node.position });
    },
    [onMove],
  );

  const handleConnect = useCallback(
    (c: Connection) => {
      if (c.source && c.target) onConnect(c.source, c.target);
    },
    [onConnect],
  );

  const addNode = () => {
    const id = prompt("new node id (kebab-case):");
    if (!id) return;
    const mode = prompt("mode: agent | script | wait | chat", "agent") ?? "agent";
    onAddNode({ id, mode });
  };

  return (
    <>
      <div className="canvas-tools">
        <button className={editMode ? "active" : ""} onClick={() => setEditMode((v) => !v)} title="drag between handles to add an edge; select an edge and press Delete to remove it">
          {editMode ? "editing graph" : "edit graph"}
        </button>
        {editMode && (
          <>
            <button onClick={addNode}>+ node</button>
            {selected && !selected.item && (
              <button className="danger" onClick={() => confirm(`Delete node "${selected.node}" and its file?`) && onRemoveNode(selected.node)}>
                delete {selected.node}
              </button>
            )}
          </>
        )}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, n) => {
          if (!(n.id in (m?.foreach ?? {}))) onSelect({ node: n.id });
        }}
        onConnect={editMode ? handleConnect : undefined}
        onEdgesDelete={(deleted) => {
          if (editMode) for (const e of deleted) onRemoveEdge(e.source, e.target);
        }}
        nodesConnectable={editMode}
        deleteKeyCode={editMode ? "Delete" : null}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </>
  );
}

function placeholderView(m: NonNullable<State["manifest"]>, id: string): NodeView {
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
  };
}

function placeholderForeach(m: NonNullable<State["manifest"]>, id: string): ForeachView {
  const fe = m.foreach[id];
  return { id, source: `${fe.source.node}.${fe.source.key}`, expanded: false, items: [], needs: fe.needs, nodes: fe.nodes };
}
