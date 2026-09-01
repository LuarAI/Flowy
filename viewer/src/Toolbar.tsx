import { useState } from "react";
import { fmtCost, fmtDuration, type State } from "./client";

interface Props {
  state: State;
  runId?: string;
  onSelectRun: (id?: string) => void;
  onRun: (opts: { run?: string; until?: string; inputs?: Record<string, unknown>; recompile?: boolean }) => void;
  onStop: () => void;
  onToggleLog: () => void;
  showLog: boolean;
}

export function Toolbar({ state, runId, onSelectRun, onRun, onStop, onToggleLog, showLog }: Props) {
  const [showNew, setShowNew] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [until, setUntil] = useState("");
  const m = state.manifest;
  const ov = state.overview;
  const running = !!state.running;

  const inputDecls = Object.entries(m?.inputs ?? {});
  const startNew = () => {
    const filled: Record<string, unknown> = {};
    for (const [k, d] of inputDecls) {
      const v = inputs[k];
      if (v !== undefined && v !== "") filled[k] = v;
      else if (d.default === undefined && d.required) return alert(`input "${k}" is required`);
    }
    onRun({ inputs: filled, until: until || undefined });
    setShowNew(false);
  };

  return (
    <div className="toolbar">
      <div className="brand">
        <strong>Flowy</strong>
        <span className="muted">{m?.name ?? "(compile error)"}</span>
      </div>
      <div className="grow" />
      {ov && (
        <div className="stats">
          <span className={`pill status-${ov.run.status}`}>{ov.run.status}</span>
          <span>
            {ov.totals.done}/{ov.totals.total} done
          </span>
          {ov.totals.cost_usd > 0 && <span>{fmtCost(ov.totals.cost_usd)}</span>}
          {ov.totals.duration_ms > 0 && <span>{fmtDuration(ov.totals.duration_ms)}</span>}
          {ov.pending.length > 0 && <span className="pill status-gate">{ov.pending.length} waiting on you</span>}
        </div>
      )}
      <select value={runId ?? ""} onChange={(e) => onSelectRun(e.target.value || undefined)} title="run">
        <option value="">latest run</option>
        {state.runs.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {running ? (
        <button className="danger" onClick={onStop}>
          ■ stop
        </button>
      ) : (
        <>
          {ov && (
            <button className="primary" onClick={() => onRun({ run: ov.run.id })} title="resume this run">
              ▶ continue
            </button>
          )}
          {ov && state.liveManifestDiffers && (
            <button onClick={() => onRun({ run: ov.run.id, recompile: true })} title="recompile the edited workflow into this run, then continue">
              ↻ recompile + continue
            </button>
          )}
          <button onClick={() => setShowNew((v) => !v)} disabled={!m}>
            + new run
          </button>
        </>
      )}
      <button onClick={onToggleLog} className={showLog ? "active" : ""}>
        log
      </button>
      {showNew && m && (
        <div className="modal">
          <h3>New run</h3>
          {inputDecls.length === 0 && <p className="muted">This workflow declares no inputs.</p>}
          {inputDecls.map(([k, d]) => (
            <label key={k}>
              <span>
                {k} <em className="muted">{d.type}</em>
                {d.required && !d.default ? " *" : ""}
              </span>
              <input placeholder={d.default !== undefined ? String(d.default) : (d.description ?? "")} value={inputs[k] ?? ""} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} />
              {d.description && <small className="muted">{d.description}</small>}
            </label>
          ))}
          <label>
            <span>run until (optional)</span>
            <select value={until} onChange={(e) => setUntil(e.target.value)}>
              <option value="">— whole workflow —</option>
              {m.top.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button className="primary" onClick={startNew}>
              start
            </button>
            <button onClick={() => setShowNew(false)}>cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
