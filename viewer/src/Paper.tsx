import { useEffect, useState } from "react";
import { addrParams, fmtBytes, get, post, type NodeAddr, type NodeDetail, type State } from "./client";
import { dotColor, humanMode, humanStatus, itemWorst } from "./Canvas";
import { Box, Check, FileIcon, Pencil, Play, Redo, X } from "./icons";

const WRONG = ["failed", "blocked", "missing_output", "schema_invalid", "timeout", "interrupted"];

export type PaperTarget = { kind: "step"; addr: NodeAddr } | { kind: "item"; foreach: string; id: string };

interface Props {
  state: State;
  target: PaperTarget;
  onOpen: (t: PaperTarget) => void;
  onClose: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}

export function Paper(props: Props) {
  return (
    <div className="overlay" onClick={props.onClose}>
      <div className="paper" onClick={(e) => e.stopPropagation()}>
        <div className="close" onClick={props.onClose}>
          <X />
        </div>
        {props.target.kind === "item" ? <ItemPaper {...props} target={props.target} /> : <StepPaper {...props} target={props.target} />}
      </div>
    </div>
  );
}

function ItemPaper({ state, target, onOpen, act }: Props & { target: Extract<PaperTarget, { kind: "item" }> }) {
  const fe = state.overview?.foreach.find((f) => f.id === target.foreach);
  const it = fe?.items.find((i) => i.id === target.id);
  if (!fe || !it) return <div className="muted">this item is gone</div>;
  const parked = it.state === "skipped";
  const runId = state.overview?.run.id;
  return (
    <>
      <h1 className={parked ? "strike" : ""}>{it.id}</h1>
      <div className="sub">
        {fe.id} · {itemWorst(it).status}
      </div>
      <div className="steps">
        {it.nodes.map((n) => (
          <div key={n.id} className="step" onClick={() => onOpen({ kind: "step", addr: n.addr })}>
            <span className="dot" style={{ background: dotColor(n.status) }} />
            <span style={{ flex: 1 }}>{n.title}</span>
            <span className="muted small">{humanStatus(n)}</span>
          </div>
        ))}
      </div>
      <div className="actions">
        {parked ? (
          <button onClick={() => act(() => post("/api/skip", { run: runId, foreach: fe.id, item: it.id, undo: true }))}>bring it back</button>
        ) : (
          <button className="ghost" onClick={() => act(() => post("/api/skip", { run: runId, foreach: fe.id, item: it.id }))}>
            park it for later
          </button>
        )}
      </div>
    </>
  );
}

function StepPaper({ state, target, act, onClose }: Props & { target: Extract<PaperTarget, { kind: "step" }> }) {
  const addr = target.addr;
  const runId = state.overview?.run.id;
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [chatCmd, setChatCmd] = useState<string | null>(null);
  const itemParam = addr.item ? `${addr.item.foreach}/${addr.item.id}` : undefined;

  useEffect(() => {
    let live = true;
    get<NodeDetail>("/api/node", { run: runId, ...addrParams(addr), version })
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [addr.node, addr.item?.id, runId, version, state.overview?.totals.done, state.running]);

  const spec = state.manifest?.nodes[addr.node];
  if (!detail) {
    return (
      <>
        <h1>{spec?.title ?? addr.node}</h1>
        <div className="sub">{spec ? `${humanMode(spec.mode)} · hasn't run yet` : "…"}</div>
        {spec && <p className="muted">it runs when everything before it is done — press run and come back.</p>}
      </>
    );
  }

  const v = detail.view;
  const yours = v.status === "gate" || v.status === "waiting";
  const wrong = WRONG.includes(v.status);
  const files = detail.outputs.filter((o) => !o.path.startsWith("_"));
  const showApprove = v.status === "gate" && v.approveFields;

  return (
    <>
      <h1>{v.title}</h1>
      <div className="sub">
        {itemParam ? `${addr.item!.id} · ` : ""}
        {humanMode(v.mode)}
        {v.result?.duration_ms ? ` · ${Math.round(v.result.duration_ms / 1000)}s` : ""}
        {v.result?.cost_usd ? ` · ≈$${v.result.cost_usd.toFixed(2)}` : ""}
        {` · ${humanStatus(v)}`}
      </div>

      {yours && <div className="yours-line">{v.status === "gate" ? "your call — read below, then decide" : (v.hint ?? "waiting for your files")}</div>}

      {wrong && (
        <>
          <div className="error">{v.result?.error ?? "something went wrong"}</div>
          {(detail.stderr || detail.trace.length > 0) && (
            <details>
              <summary>what happened</summary>
              <pre>
                {detail.trace
                  .slice(-12)
                  .map((e) => `${e.type}: ${summarize(e.payload)}`)
                  .join("\n")}
                {detail.stderr ? `\n--- stderr ---\n${detail.stderr}` : ""}
              </pre>
            </details>
          )}
        </>
      )}

      {v.status === "waiting" && (
        <>
          <div className="pathline">drop the file(s) here: {detail.versionDir}\out</div>
          {v.mode === "chat" && (
            <div className="actions">
              <button onClick={() => get<{ command: string }>("/api/chat-command", { run: runId, ...addrParams(addr) }).then((r) => setChatCmd(r.command))}>
                <Pencil /> talk it through in a terminal
              </button>
              <button className="ghost" onClick={() => act(() => post("/api/done", { run: runId, node: addr.node, item: itemParam })).then(onClose)}>
                the files are there — done
              </button>
            </div>
          )}
          {v.mode === "wait" && (
            <div className="actions">
              <button onClick={() => act(() => post("/api/done", { run: runId, node: addr.node, item: itemParam })).then(onClose)}>
                <Check size={15} /> the files are there — done
              </button>
            </div>
          )}
          {chatCmd && <pre style={{ userSelect: "all", fontSize: 13 }}>{chatCmd}</pre>}
        </>
      )}

      {files.map((o) => (
        <div key={o.path}>
          <div className="filehead">
            <FileIcon size={13} />
            <span className="fname">{o.path}</span>
            <span className="muted small">{fmtBytes(o.bytes)}</span>
            <span className="grow" />
            <a
              className="chip"
              href={`/api/file?${new URLSearchParams({ run: runId ?? "", node: addr.node, ...(itemParam ? { item: itemParam } : {}), ...(version ? { version } : {}), path: o.path })}`}
              target="_blank"
              rel="noreferrer"
            >
              open
            </a>
          </div>
          {o.text !== null && <pre>{o.text}</pre>}
        </div>
      ))}

      {showApprove && (
        <div style={{ marginTop: 14 }}>
          {Object.entries(v.approveFields!)
            .filter(([k]) => k !== "notes")
            .map(([k, f]) => (
              <label key={k}>
                <span>
                  {k}
                  {f.required ? " — needed" : ""} {f.description ? `· ${f.description}` : ""}
                </span>
                {f.type === "boolean" ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    <button className={fields[k] === "true" ? "primary" : ""} onClick={() => setFields({ ...fields, [k]: "true" })}>
                      yes
                    </button>
                    <button className={fields[k] === "false" ? "primary" : ""} onClick={() => setFields({ ...fields, [k]: "false" })}>
                      no
                    </button>
                  </div>
                ) : (
                  <input value={fields[k] ?? ""} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} />
                )}
              </label>
            ))}
        </div>
      )}

      {(showApprove || v.status === "done" || wrong || v.status === "stale") && (
        <div className="noteline">
          <Pencil />
          <input placeholder="scribble a note (used if you redo)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}

      <div className="actions">
        {showApprove && (
          <button
            className="primary"
            onClick={() =>
              act(() =>
                post("/api/approve", {
                  run: runId,
                  node: addr.node,
                  item: itemParam,
                  fields: { ...fields, ...(note && v.approveFields && "notes" in v.approveFields ? { notes: note } : {}) },
                }),
              ).then(onClose)
            }
          >
            <Check size={15} color="#fffdf9" /> approve
          </button>
        )}
        {(showApprove || v.status === "done" || wrong || v.status === "stale") && !state.running && (
          <button onClick={() => act(() => post("/api/rerun", { run: runId, node: addr.node, item: itemParam, feedback: note || undefined })).then(onClose)}>
            <Redo /> {wrong ? "try again" : "redo"} {note ? "with my note" : ""}
          </button>
        )}
        {v.status === "stale" && !state.running && (
          <span className="muted small">changed since it ran: {v.staleReasons.slice(0, 2).join(", ")} — press run to refresh</span>
        )}
        {itemParam && v.status === "gate" && (
          <button className="ghost" onClick={() => act(() => post("/api/skip", { run: runId, foreach: addr.item!.foreach, item: addr.item!.id })).then(onClose)}>
            park it
          </button>
        )}
        {(v.mode === "agent" || v.mode === "chat") && v.version && !yours && (
          <button className="ghost" onClick={() => get<{ command: string }>("/api/chat-command", { run: runId, ...addrParams(addr) }).then((r) => setChatCmd(r.command))}>
            continue in a terminal
          </button>
        )}
      </div>
      {chatCmd && v.status !== "waiting" && <pre style={{ userSelect: "all", fontSize: 13 }}>{chatCmd}</pre>}

      {v.versions.length > 1 && (
        <div className="versions-line">
          <span>attempts:</span>
          {v.versions.map((ver) => (
            <span
              key={ver}
              className={`v ${(version ?? v.version) === ver ? "cur" : ""}`}
              onClick={() => setVersion(ver === v.version ? undefined : ver)}
              title={ver === v.version ? "the one in use" : "peek at this attempt"}
            >
              {ver}
            </span>
          ))}
          {version && version !== v.version && (
            <button className="ghost small" onClick={() => act(() => post("/api/use", { run: runId, node: addr.node, item: itemParam, version })).then(() => setVersion(undefined))}>
              use this one
            </button>
          )}
        </div>
      )}
      {detail.versionDir && <div className="pathline">{detail.versionDir}\out</div>}
    </>
  );
}

function summarize(p: unknown): string {
  if (typeof p === "string") return p.slice(0, 160);
  if (p && typeof p === "object") {
    const o = p as Record<string, unknown>;
    for (const k of ["text", "thinking", "command", "result", "message"]) if (typeof o[k] === "string") return (o[k] as string).slice(0, 160).replace(/\n/g, " ");
    if (typeof o.name === "string") return o.name;
    return JSON.stringify(o).slice(0, 160);
  }
  return String(p);
}

export { Box, Play };
