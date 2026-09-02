import { useState } from "react";
import { Play, Stop, X } from "./icons";
import type { State } from "./client";

interface Props {
  state: State;
  onRun: (opts: { run?: string; inputs?: Record<string, unknown>; recompile?: boolean }) => void;
  onStop: () => void;
}

export function Header({ state, onRun, onStop }: Props) {
  const [showNew, setShowNew] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const m = state.manifest;
  const ov = state.overview;
  const running = !!state.running;
  const needs = ov?.pending.length ?? 0;
  const inputDecls = Object.entries(m?.inputs ?? {});

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

  return (
    <div className="header">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span className="logo">flowy</span>
        <span className="wf">/ {m?.name ?? "…"}</span>
        {state.liveManifestDiffers && ov && !running && (
          <button className="ghost small" title="the files changed since this run started" onClick={() => onRun({ run: ov.run.id, recompile: true })}>
            files changed — refresh the run
          </button>
        )}
      </div>
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
          {ov && ov.run.status !== "done" && (
            <button onClick={() => onRun({ run: ov.run.id })}>
              <Play /> {ov.totals.done > 0 || needs > 0 ? "continue" : "run"}
            </button>
          )}
          {(!ov || ov.run.status === "done") && m && (
            <button onClick={() => (inputDecls.length ? setShowNew(true) : onRun({}))}>
              <Play /> run
            </button>
          )}
        </>
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
                <input
                  placeholder={d.default !== undefined ? String(d.default) : d.type === "path" ? "paste a path (right-click a folder → Copy as path)" : ""}
                  value={inputs[k] ?? ""}
                  onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })}
                />
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
