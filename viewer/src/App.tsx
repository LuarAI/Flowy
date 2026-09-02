import { useCallback, useEffect, useState } from "react";
import { Canvas } from "./Canvas";
import { Header } from "./Header";
import { Paper, type PaperTarget } from "./Paper";
import { get, post, type NodeAddr, type State } from "./client";

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [paper, setPaper] = useState<PaperTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await get<State>("/api/state");
      setState(s);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") setState(msg.state);
        else if (msg.type === "node" || msg.type === "running") void refresh();
        else if (msg.type === "error") setError(msg.message);
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 1500);
      };
    };
    connect();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPaper(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      closed = true;
      ws.close();
      window.removeEventListener("keydown", onKey);
    };
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        setError(null);
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refresh],
  );

  if (!state) {
    return (
      <div className="app" style={{ alignItems: "center", justifyContent: "center" }}>
        <div className="hand muted" style={{ fontSize: 20 }}>
          {error ?? "opening the workflow…"}
        </div>
      </div>
    );
  }

  const openStep = (a: NodeAddr) => setPaper({ kind: "step", addr: a });
  const openItem = (fe: string, id: string) => setPaper({ kind: "item", foreach: fe, id });

  return (
    <div className="app">
      <Header state={state} onRun={(opts) => act(() => post("/api/run", opts))} onStop={() => act(() => post("/api/stop"))} />
      {error && (
        <div className="err-note" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {state.compileError && <div className="err-note" style={{ top: 60 }}>{state.compileError}</div>}
      <div className="canvas-wrap">
        <Canvas state={state} onOpen={openStep} onOpenItem={openItem} onMove={(positions) => post("/api/layout", { positions })} />
      </div>
      {paper && <Paper state={state} target={paper} onOpen={setPaper} onClose={() => setPaper(null)} act={act} />}
    </div>
  );
}
