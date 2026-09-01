import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "./Canvas";
import { NodePanel } from "./NodePanel";
import { Toolbar } from "./Toolbar";
import { get, post, type NodeAddr, type State } from "./client";

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<NodeAddr | null>(null);
  const [selectedItem, setSelectedItem] = useState<{ foreach: string; id: string } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async (id?: string) => {
    try {
      const s = await get<State>("/api/state", { run: id });
      setState(s);
      setLogs(s.logs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh(runId);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") {
          // The server pushes the running run's state; if the user is looking at another run, refetch that one.
          if (!runId || msg.state.overview?.run?.id === runId) {
            setState(msg.state);
            setLogs(msg.state.logs);
          } else void refresh(runId);
        } else if (msg.type === "log") setLogs((l) => [...l.slice(-300), msg.message]);
        else if (msg.type === "node" || msg.type === "running") void refresh(runId);
        else if (msg.type === "error") setError(msg.message);
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      ws.close();
    };
  }, [runId, refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(null);
        await refresh(runId);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh, runId],
  );

  if (!state) return <div className="empty">{error ?? "connecting…"}</div>;

  const ov = state.overview;
  return (
    <div className="app">
      <Toolbar
        state={state}
        runId={runId}
        onSelectRun={(id) => {
          setRunId(id);
          setSelected(null);
          setSelectedItem(null);
        }}
        onRun={(opts) => act(() => post("/api/run", opts))}
        onStop={() => act(() => post("/api/stop"))}
        onToggleLog={() => setShowLog((v) => !v)}
        showLog={showLog}
      />
      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {state.compileError && <div className="banner error pre">{state.compileError}</div>}
      {state.liveManifestDiffers && !state.compileError && (
        <div className="banner warn">The workflow files changed since this run was compiled. New runs use the new files; resume this run with “recompile” to pick them up.</div>
      )}
      <div className="main">
        <div className="canvas-wrap">
          <Canvas
            state={state}
            selected={selected}
            selectedItem={selectedItem}
            onSelect={(a) => {
              setSelected(a);
              setSelectedItem(null);
            }}
            onSelectItem={(fe, id) => {
              setSelectedItem({ foreach: fe, id });
              setSelected(null);
            }}
            onMove={(positions) => post("/api/layout", { positions })}
            onConnect={(from, to) => act(() => post("/api/graph/edge", { op: "add", from, to }))}
            onRemoveEdge={(from, to) => act(() => post("/api/graph/edge", { op: "remove", from, to }))}
            onAddNode={(n) => act(() => post("/api/graph/node", n))}
            onRemoveNode={(id) => act(() => post("/api/graph/node", { op: "remove", id }))}
          />
        </div>
        {(selected || selectedItem) && (
          <div className="panel">
            <NodePanel
              key={selected ? `${selected.node}:${selected.item?.id ?? ""}` : `item:${selectedItem?.foreach}/${selectedItem?.id}`}
              state={state}
              runId={ov?.run.id}
              addr={selected}
              item={selectedItem}
              onSelect={(a) => {
                setSelected(a);
                setSelectedItem(null);
              }}
              onClose={() => {
                setSelected(null);
                setSelectedItem(null);
              }}
              act={act}
            />
          </div>
        )}
      </div>
      {showLog && (
        <div className="log">
          {logs.slice(-200).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
