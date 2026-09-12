import { useCallback, useEffect, useState } from "react";
import { FlowCanvas, type OpenTarget } from "./FlowCanvas";
import { Header, type View } from "./Header";
import { LineMap } from "./LineMap";
import { Paper, type PaperTarget } from "./Paper";
import { Sidebar } from "./Sidebar";
import { get, post, type State } from "./client";

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [paper, setPaper] = useState<PaperTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewRaw] = useState<View | null>(null);

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
        else if (msg.type === "chat") window.dispatchEvent(new CustomEvent("flowy:chat-event", { detail: msg }));
        else if (msg.type === "perm") window.dispatchEvent(new CustomEvent("flowy:perm", { detail: msg }));
        else if (msg.type === "perm-done") window.dispatchEvent(new CustomEvent("flowy:perm-done", { detail: msg }));
        else if (msg.type === "node" || msg.type === "running" || msg.type === "line") void refresh();
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

  // The map is home once lines exist; the canvas is the workshop where they are born.
  const viewKey = `flowy-view:${state.dir}`;
  let effective: View = view ?? "canvas";
  if (!view) {
    try {
      const saved = localStorage.getItem(viewKey) as View | null;
      effective = saved ?? ((state.lines?.length ?? 0) > 0 ? "map" : "canvas");
    } catch {
      effective = (state.lines?.length ?? 0) > 0 ? "map" : "canvas";
    }
  }
  const setView = (v: View) => {
    setViewRaw(v);
    try {
      localStorage.setItem(viewKey, v);
    } catch {
      /* storage unavailable */
    }
  };

  const open = (t: OpenTarget) => {
    if (t.kind === "step" && t.addr) setPaper({ kind: "step", addr: t.addr });
    else if (t.kind === "item" && t.foreach && t.id) setPaper({ kind: "item", foreach: t.foreach, id: t.id });
    else if (t.kind === "checklist" && t.foreach) setPaper({ kind: "checklist", foreach: t.foreach });
  };

  const needs =
    (state.overview?.pending.length ?? 0) +
    (state.lines ?? []).reduce((n, b) => n + b.lines.filter((l) => !l.parked && (l.line.state === "waiting" || l.line.state === "failed")).length, 0);

  return (
    <div className="app with-side">
      <Sidebar needs={needs} />
      <div className="app-main">
        <Header state={state} view={effective} onView={setView} onRun={(opts) => act(() => post("/api/run", opts))} onStop={() => act(() => post("/api/stop"))} act={act} />
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
        <div className="canvas-wrap">{effective === "map" ? <LineMap state={state} onOpen={open} onError={setError} act={act} /> : <FlowCanvas state={state} onOpen={open} onError={setError} act={act} />}</div>
        {paper && <Paper state={state} target={paper} onOpen={setPaper} onClose={() => setPaper(null)} act={act} />}
      </div>
    </div>
  );
}
