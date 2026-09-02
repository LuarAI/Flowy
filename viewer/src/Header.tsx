import { useState } from "react";
import { Folder, Play, Redo, Stop, X } from "./icons";
import { post, type State } from "./client";

interface Props {
  state: State;
  onRun: (opts: { run?: string; inputs?: Record<string, unknown>; recompile?: boolean }) => void;
  onStop: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}

export function Header({ state, onRun, onStop, act }: Props) {
  const [showNew, setShowNew] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [ctxMenu, setCtxMenu] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteName, setNoteName] = useState("");
  const [noteText, setNoteText] = useState("");
  const m = state.manifest;
  const ov = state.overview;
  const running = !!state.running;
  const needs = ov?.pending.length ?? 0;
  const inputDecls = Object.entries(m?.inputs ?? {});
  const empty = (m?.top.length ?? 0) === 0;

  const start = () => {
    const filled: Record<string, unknown> = {};
    for (const [k, d] of inputDecls) {
      const v = inputs[k];
      if (v !== undefined && v !== "") filled[k] = v;
      else if (d.required && d.default === undefined) return;
    }
    onRun({ inputs: filled });
    setShowNew(false);
  };

  const pickContext = async (kind: "file" | "folder") => {
    try {
      const r = await post<{ path: string | null }>("/api/pick", { kind });
      if (r.path) window.dispatchEvent(new CustomEvent("flowy:add-source", { detail: { path: r.path } }));
    } catch {
      window.dispatchEvent(new CustomEvent("flowy:add-source", { detail: {} })); // fall back to asking on-canvas
    }
  };

  return (
    <div className="header">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="logo">flowy</span>
        <span className="wf">/ {m?.name ?? "…"}</span>
      </div>
      <button className="ghost" onClick={() => window.dispatchEvent(new CustomEvent("flowy:add-step"))} title="a new conversation on the canvas">
        + chat
      </button>
      <div style={{ position: "relative" }}>
        <button className="ghost" onClick={() => setCtxMenu((v) => !v)} title="give the chats something to read">
          + context
        </button>
        {ctxMenu && (
          <div className="menu" onMouseLeave={() => setCtxMenu(false)}>
            <button
              className="ghost"
              onClick={() => {
                setCtxMenu(false);
                void pickContext("file");
              }}
            >
              pick a file
            </button>
            <button
              className="ghost"
              onClick={() => {
                setCtxMenu(false);
                void pickContext("folder");
              }}
            >
              pick a folder
            </button>
            <button
              className="ghost"
              onClick={() => {
                setCtxMenu(false);
                setNoteOpen(true);
                setNoteName("");
                setNoteText("");
              }}
            >
              write a note
            </button>
          </div>
        )}
      </div>
      {state.undo > 0 && !running && (
        <button className="ghost" onClick={() => act(() => post("/api/graph/undo"))} title="undo the last canvas edit to the files">
          <Redo size={13} color="#8a857c" /> undo edit
        </button>
      )}
      <div className="grow" />
      {needs > 0 && (
        <span className="needs-you">
          {needs} thing{needs === 1 ? "" : "s"} need{needs === 1 ? "s" : ""} you
        </span>
      )}
      {running ? (
        <button onClick={onStop}>
          <Stop /> stop
        </button>
      ) : (
        <>
          {ov && ov.run.status !== "done" && !empty && (
            <button onClick={() => onRun({ run: ov.run.id, recompile: state.liveManifestDiffers || undefined })} title={state.liveManifestDiffers ? "the files changed — the run picks them up" : undefined}>
              <Play /> {ov.totals.done > 0 || needs > 0 ? "continue" : "run"}
            </button>
          )}
          {(!ov || ov.run.status === "done") && m && !empty && (
            <button onClick={() => (inputDecls.length ? setShowNew(true) : onRun({}))}>
              <Play /> run
            </button>
          )}
        </>
      )}

      {noteOpen && (
        <div className="overlay" onClick={() => setNoteOpen(false)}>
          <div className="paper" style={{ width: 480, marginTop: 40 }} onClick={(e) => e.stopPropagation()}>
            <div className="close" onClick={() => setNoteOpen(false)}>
              <X />
            </div>
            <h1>write a note</h1>
            <div className="sub">saved as a markdown file in the workflow's context folder — then wire it to a chat</div>
            <label>
              <span>name</span>
              <input autoFocus value={noteName} onChange={(e) => setNoteName(e.target.value)} placeholder="e.g. tone rules" />
            </label>
            <label>
              <span>the note</span>
              <textarea rows={8} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="whatever the chats should know…" />
            </label>
            <div className="actions">
              <button
                className="primary"
                disabled={!noteText.trim()}
                onClick={() =>
                  act(async () => {
                    const r = await post<{ path: string }>("/api/context-note", { name: noteName || "note", text: noteText });
                    window.dispatchEvent(new CustomEvent("flowy:add-source", { detail: { path: r.path } }));
                    setNoteOpen(false);
                  })
                }
              >
                save it
              </button>
              <button className="ghost" onClick={() => setNoteOpen(false)}>
                never mind
              </button>
            </div>
          </div>
        </div>
      )}
      {showNew && m && (
        <div className="overlay" onClick={() => setShowNew(false)}>
          <div className="paper" style={{ width: 460, marginTop: 40 }} onClick={(e) => e.stopPropagation()}>
            <div className="close" onClick={() => setShowNew(false)}>
              <X />
            </div>
            <h1>run {m.name}</h1>
            <div className="sub">fill what it needs, leave the rest</div>
            {inputDecls.map(([k, d]) => (
              <label key={k}>
                <span>
                  {k}
                  {d.required && d.default === undefined ? " — needed" : ""} {d.description ? `· ${d.description}` : ""}
                </span>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    placeholder={d.default !== undefined ? String(d.default) : d.type === "path" ? "paste a path, or browse →" : ""}
                    value={inputs[k] ?? ""}
                    onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })}
                  />
                  {d.type === "path" && (
                    <button
                      className="ghost"
                      title="browse"
                      onClick={() =>
                        post<{ path: string | null }>("/api/pick", { kind: "folder" }).then((r) => r.path && setInputs((cur) => ({ ...cur, [k]: r.path! })))
                      }
                    >
                      <Folder size={16} />
                    </button>
                  )}
                </div>
              </label>
            ))}
            <div className="actions">
              <button className="primary" onClick={start}>
                <Play color="#fffdf9" /> start
              </button>
              <button className="ghost" onClick={() => setShowNew(false)}>
                never mind
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
