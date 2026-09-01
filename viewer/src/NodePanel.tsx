import { useEffect, useState } from "react";
import { addrParams, fmtBytes, fmtCost, fmtDuration, get, post, STATUS_COLORS, type NodeAddr, type NodeDetail, type State, type TraceEvent } from "./client";
import { itemStatus } from "./Canvas";

interface Props {
  state: State;
  runId?: string;
  addr: NodeAddr | null;
  item: { foreach: string; id: string } | null;
  onSelect: (a: NodeAddr) => void;
  onClose: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}

export function NodePanel(props: Props) {
  if (props.item && !props.addr) return <ItemPanel {...props} item={props.item} />;
  return <NodeDetailPanel {...props} addr={props.addr!} />;
}

function ItemPanel({ state, item, onSelect, onClose, act, runId }: Props & { item: { foreach: string; id: string } }) {
  const fe = state.overview?.foreach.find((f) => f.id === item.foreach);
  const it = fe?.items.find((i) => i.id === item.id);
  if (!fe || !it) return <div className="panel-body">item not found</div>;
  const status = itemStatus(it.state, it.nodes);
  return (
    <div className="panel-body">
      <div className="panel-head">
        <span className="badge" style={{ background: STATUS_COLORS[status] }}>
          {status}
        </span>
        <h2>
          {fe.id} / {it.id}
        </h2>
        <button className="icon" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="row">
        {it.state === "skipped" ? (
          <button onClick={() => act(() => post("/api/skip", { run: runId, foreach: fe.id, item: it.id, undo: true }))}>bring back</button>
        ) : (
          <button onClick={() => act(() => post("/api/skip", { run: runId, foreach: fe.id, item: it.id }))}>skip (not now)</button>
        )}
        {it.cost > 0 && <span className="muted">{fmtCost(it.cost)}</span>}
      </div>
      {it.item && (
        <details open>
          <summary>item data</summary>
          <pre className="small">{JSON.stringify(it.item, null, 2)}</pre>
        </details>
      )}
      <h3>steps</h3>
      <div className="steps">
        {it.nodes.map((n) => (
          <div key={n.id} className="step" onClick={() => onSelect(n.addr)}>
            <span className="dot" style={{ background: STATUS_COLORS[n.status] }} />
            <strong>{n.id}</strong>
            <span className="muted small">{n.status}</span>
            <span className="muted small grow-r">{n.version ?? ""}</span>
            <span className="muted small">{fmtCost(n.result?.cost_usd)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeDetailPanel({ state, addr, runId, onClose, act }: Props & { addr: NodeAddr }) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [tab, setTab] = useState<"outputs" | "prompt" | "trace" | "versions" | "inputs" | "edit">("outputs");
  const [err, setErr] = useState<string | null>(null);
  const [approval, setApproval] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const [compare, setCompare] = useState<string | null>(null);
  const [compareDetail, setCompareDetail] = useState<NodeDetail | null>(null);
  const [chatCmd, setChatCmd] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);

  const load = async () => {
    try {
      setDetail(await get<NodeDetail>("/api/node", { run: runId, ...addrParams(addr) }));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      // no run yet: show manifest-only info
      setDetail(null);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addr.node, addr.item?.id, runId, state.overview?.totals.done, state.running]);

  useEffect(() => {
    if (!compare) return setCompareDetail(null);
    void get<NodeDetail>("/api/node", { run: runId, ...addrParams(addr), version: compare }).then(setCompareDetail);
  }, [compare, addr, runId]);

  const spec = state.manifest?.nodes[addr.node];
  const v = detail?.view;
  const status = v?.status ?? "pending";
  const isItem = !!addr.item;
  const itemParam = addr.item ? `${addr.item.foreach}/${addr.item.id}` : undefined;

  return (
    <div className="panel-body">
      <div className="panel-head">
        <span className="badge" style={{ background: STATUS_COLORS[status] }}>
          {status}
        </span>
        <h2>
          {isItem ? `${addr.item!.foreach}/${addr.item!.id} · ` : ""}
          {addr.node}
        </h2>
        <button className="icon" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="muted small">
        {spec?.mode}
        {v?.engine ? ` · ${v.engine}` : ""}
        {spec?.lock ? ` · lock ${spec.lock}` : ""}
        {v?.version ? ` · ${v.version} of ${v.versions.length}` : " · not run yet"}
        {v?.result?.cost_usd ? ` · ${fmtCost(v.result.cost_usd)}` : ""}
        {v?.result?.duration_ms ? ` · ${fmtDuration(v.result.duration_ms)}` : ""}
        {v?.result?.tokens ? ` · ${v.result.tokens.input + v.result.tokens.output} tok` : ""}
      </div>
      {spec?.needs.length ? <div className="muted small">needs: {spec.needs.join(", ")}</div> : null}
      {err && !detail && <div className="muted small">{err}</div>}
      {v?.status === "stale" && <div className="note violet">stale: {v.staleReasons.join("; ")}</div>}
      {v?.result?.error && <div className="note red pre">{v.result.error}</div>}
      {v?.status === "waiting" && (
        <div className="note amber">
          {v.hint ?? `waiting for ${v.outputs.join(", ")}`}
          <div className="small muted">drop the file(s) into {detail?.versionDir}\out</div>
          <div className="row">
            <button onClick={() => act(() => post("/api/done", { run: runId, node: addr.node, item: itemParam }))}>mark done</button>
            {spec?.mode === "chat" && <button onClick={() => get<{ command: string }>("/api/chat-command", { run: runId, ...addrParams(addr) }).then((r) => setChatCmd(r.command))}>chat command</button>}
          </div>
          {chatCmd && <pre className="small select-all">{chatCmd}</pre>}
        </div>
      )}
      {v?.status === "gate" && v.approveFields && (
        <div className="note amber">
          <strong>Approve</strong>
          {Object.entries(v.approveFields).map(([k, f]) => (
            <label key={k}>
              <span>
                {k} <em className="muted">{f.type}</em>
                {f.required ? " *" : ""}
              </span>
              {f.type === "boolean" ? (
                <select value={approval[k] ?? ""} onChange={(e) => setApproval({ ...approval, [k]: e.target.value })}>
                  <option value="">—</option>
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              ) : f.type === "string" ? (
                <textarea rows={2} value={approval[k] ?? ""} onChange={(e) => setApproval({ ...approval, [k]: e.target.value })} placeholder={f.description ?? ""} />
              ) : (
                <input value={approval[k] ?? ""} onChange={(e) => setApproval({ ...approval, [k]: e.target.value })} placeholder={f.description ?? ""} />
              )}
            </label>
          ))}
          <div className="row">
            <button className="primary" onClick={() => act(() => post("/api/approve", { run: runId, node: addr.node, item: itemParam, fields: approval }))}>
              approve
            </button>
            <span className="muted small">you can also edit files in out/ before approving</span>
          </div>
        </div>
      )}
      {v?.approval && (
        <details>
          <summary>approval</summary>
          <pre className="small">{JSON.stringify(v.approval, null, 2)}</pre>
        </details>
      )}
      {v && v.status !== "running" && (
        <div className="note">
          <strong>Rerun</strong>
          <textarea rows={2} placeholder="feedback for the next attempt (optional)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <div className="row">
            <button disabled={!!state.running} onClick={() => act(() => post("/api/rerun", { run: runId, node: addr.node, item: itemParam, feedback: feedback || undefined }))}>
              rerun as new version
            </button>
            {(spec?.mode === "agent" || spec?.mode === "chat") && (
              <button onClick={() => get<{ command: string }>("/api/chat-command", { run: runId, ...addrParams(addr) }).then((r) => setChatCmd(r.command))}>continue in a terminal</button>
            )}
          </div>
          {chatCmd && <pre className="small select-all">{chatCmd}</pre>}
        </div>
      )}
      <div className="tabs">
        {(["outputs", "prompt", "trace", "versions", "inputs", "edit"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
            {t === "versions" && v?.versions.length ? ` (${v.versions.length})` : ""}
            {t === "trace" && detail?.trace.length ? ` (${detail.trace.length})` : ""}
          </button>
        ))}
      </div>
      {tab === "outputs" && (
        <div>
          {!detail?.outputs.length && <div className="muted small">no outputs yet{spec ? ` (declared: ${spec.outputs.join(", ")})` : ""}</div>}
          {detail?.outputs.map((o) => (
            <details key={o.path} open={o.text !== null && o.bytes < 20_000}>
              <summary>
                {o.path} <span className="muted small">{fmtBytes(o.bytes)}</span>{" "}
                <a className="small" href={`/api/file?${new URLSearchParams({ run: runId ?? "", node: addr.node, ...(itemParam ? { item: itemParam } : {}), path: o.path })}`} target="_blank" rel="noreferrer">
                  open
                </a>
              </summary>
              {o.text !== null ? <pre className="small">{o.text}</pre> : <div className="muted small">binary</div>}
            </details>
          ))}
        </div>
      )}
      {tab === "prompt" && (
        <div>
          {detail?.feedback && (
            <details open>
              <summary>feedback</summary>
              <pre className="small">{detail.feedback}</pre>
            </details>
          )}
          <pre className="small">{detail?.prompt ?? "(no prompt — script/wait node, or not run yet)"}</pre>
        </div>
      )}
      {tab === "trace" && <Trace events={detail?.trace ?? []} stderr={detail?.stderr ?? null} />}
      {tab === "versions" && v && (
        <div>
          {detail?.versions
            .slice()
            .reverse()
            .map((ver) => (
              <div key={ver.name} className={`version ${ver.current ? "current" : ""}`}>
                <span className="dot" style={{ background: STATUS_COLORS[ver.result?.status ?? "pending"] }} />
                <strong>{ver.name}</strong>
                <span className="muted small">{ver.result?.status}</span>
                <span className="muted small">{ver.result?.started?.slice(0, 16).replace("T", " ")}</span>
                <span className="muted small">{fmtCost(ver.result?.cost_usd)}</span>
                {ver.approval && <span className="small amber">approved</span>}
                <span className="grow-r" />
                {!ver.current && <button onClick={() => act(() => post("/api/use", { run: runId, node: addr.node, item: itemParam, version: ver.name }))}>use</button>}
                {!ver.current && <button onClick={() => setCompare(compare === ver.name ? null : ver.name)}>{compare === ver.name ? "hide" : "compare"}</button>}
                {ver.current && <span className="small">current</span>}
              </div>
            ))}
          {compare && compareDetail && (
            <div className="compare">
              <div>
                <h4>{v.version} (current)</h4>
                {detail?.outputs.map((o) => (
                  <details key={o.path} open>
                    <summary>{o.path}</summary>
                    <pre className="small">{o.text ?? "(binary)"}</pre>
                  </details>
                ))}
              </div>
              <div>
                <h4>{compare}</h4>
                {compareDetail.outputs.map((o) => (
                  <details key={o.path} open>
                    <summary>{o.path}</summary>
                    <pre className="small">{o.text ?? "(binary)"}</pre>
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {tab === "inputs" && (
        <div>
          <div className="muted small">files under in/ for {v?.version}</div>
          <pre className="small">{detail?.inputs.join("\n") || "(none)"}</pre>
        </div>
      )}
      {tab === "edit" && spec && (
        <div>
          <div className="muted small">Edits the node file directly (nodes/{addr.node}.md). Structural fields are better edited in your editor or by your agent.</div>
          <textarea rows={14} value={body ?? detail?.prompt?.split("\n\n").slice(1).join("\n\n") ?? ""} onChange={(e) => setBody(e.target.value)} placeholder="prompt body" />
          <div className="row">
            <button className="primary" disabled={body === null} onClick={() => act(() => post("/api/graph/node", { op: "update", id: addr.node, body: body ?? "" })).then(() => setBody(null))}>
              save body
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Trace({ events, stderr }: { events: TraceEvent[]; stderr: string | null }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!events.length && !stderr) return <div className="muted small">no trace yet</div>;
  return (
    <div className="trace">
      {events.map((e, i) => (
        <div key={i} className={`ev ev-${e.type}`} onClick={() => setOpen(open === i ? null : i)}>
          <span className="muted small mono">{e.t.slice(11, 19)}</span>
          <span className="ev-type">{e.type}</span>
          <span className="ev-sum">{summarize(e.payload)}</span>
          {open === i && <pre className="small">{JSON.stringify(e.payload, null, 2)}</pre>}
        </div>
      ))}
      {stderr && (
        <details>
          <summary>stderr</summary>
          <pre className="small">{stderr}</pre>
        </details>
      )}
    </div>
  );
}

function summarize(p: unknown): string {
  if (typeof p === "string") return p.slice(0, 200);
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.slice(0, 200);
    if (typeof o.thinking === "string") return o.thinking.slice(0, 200);
    if (typeof o.name === "string") return `${o.name} ${JSON.stringify(o.input ?? "").slice(0, 160)}`;
    if (typeof o.content === "string") return o.content.slice(0, 200);
    if (typeof o.command === "string") return o.command;
    if (typeof o.result === "string") return o.result.slice(0, 200);
    return JSON.stringify(o).slice(0, 200);
  }
  return String(p);
}
