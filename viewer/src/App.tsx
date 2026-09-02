import { useCallback, useEffect, useState } from "react";
import { ExCanvas, type OpenTarget } from "./ExCanvas";
import { Header } from "./Header";
import { Paper, type PaperTarget } from "./Paper";
import { get, post, type State } from "./client";

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
        if (msg.type === "state") {

          setState(msg.state);
        } else if (msg.type === "node" || msg.type === "running") void refresh();
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

  const open = (t: OpenTarget) => {
    if (t.kind === "step" && t.addr) setPaper({ kind: "step", addr: t.addr });
    else if (t.kind === "item" && t.foreach && t.id) setPaper({ kind: "item", foreach: t.foreach, id: t.id });
    else if (t.kind === "checklist" && t.foreach) setPaper({ kind: "checklist", foreach: t.foreach });
  };

  return (
    <div className="app">
      <Header state={state} onRun={(opts) => act(() => post("/api/run", opts))} onStop={() => act(() => post("/api/stop"))} act={act} />
      {error && (
        <div className="err-note" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {state.compileError && (
        <div className="err-note" style={{ top: 60 }}>
          {state.compileError}
        </div>
      )}
      <div className="canvas-wrap">
        <ExCanvas state={state} onOpen={open} onError={setError} />
      </div>
      {paper && <Paper state={state} target={paper} onOpen={setPaper} onClose={() => setPaper(null)} act={act} />}
    </div>
  );
}
