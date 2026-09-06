import { useEffect, useMemo, useState } from "react";
import { ChatView } from "./ChatView";
import { post, type LineView, type LinesView, type NodeAddr, type State } from "./client";
import { Check, Pencil, Play, X } from "./icons";
import type { OpenTarget } from "./FlowCanvas";

/*
 * Live service: the map is the home screen. One trunk per lines block
 * (its `needs:`), a junction, one colored line per departed item, stations
 * = the recipe's steps, the train = where that line is. Amber is sacred:
 * the only thing that glows is a station where a human is the worker.
 * Nothing here is arranged by hand — the geometry comes from the files.
 */

const PALETTE = ["#159a8c", "#c2467f", "#3b6fc9", "#7a8f2a", "#8b5cf6", "#b45309", "#0e7490", "#be123c"];
const LABEL_W = 176;
const STN = 84;
const ROW = 58;
const TOP = 66;

interface Sel {
  foreach: string;
  item: string;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

function lineColor(block: LinesView, item: string): string {
  const i = block.lines.findIndex((l) => l.item === item);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

/** What a waiting line needs from the human, in one line. */
function needsLine(l: LineView): string {
  const st = l.steps[l.line.step];
  if (l.line.state === "failed") return `went wrong at ${st?.title ?? "a station"} — ${l.line.note ?? "open it"}`;
  if (l.line.note) return l.line.note;
  if (l.gate === "you") return `your station: ${st?.title ?? ""}`;
  if (l.gate === "confirm") return `${st?.title ?? "station"} — done, your go`;
  return st?.title ?? "";
}

function active(l: LineView): boolean {
  return l.line.state !== "done" && !l.parked;
}

export function LineMap({ state, onOpen, onError, act }: { state: State; onOpen: (t: OpenTarget) => void; onError: (m: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [sel, setSel] = useState<Sel | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [depot, setDepot] = useState<string | null | "new">(null);
  const [showPast, setShowPast] = useState(false);
  const blocks = state.lines ?? [];
  const selected = sel ? blocks.find((b) => b.id === sel.foreach)?.lines.find((l) => l.item === sel.item) ?? null : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (sheet) setSheet(null);
        else if (depot) setDepot(null);
        else setSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, depot]);

  // the departures board: every line waiting on a human, plus trunk gates, longest wait first
  const board = useMemo(() => {
    const rows: Array<{ key: string; color: string; title: string; what: string; since: string | null; go: () => void; calm?: boolean }> = [];
    for (const b of blocks) {
      for (const l of b.lines) {
        if (!active(l)) continue;
        if (l.line.state === "waiting" || l.line.state === "failed")
          rows.push({ key: `${b.id}/${l.item}`, color: lineColor(b, l.item), title: l.title, what: needsLine(l), since: l.line.waitingSince, go: () => setSel({ foreach: b.id, item: l.item }) });
      }
    }
    for (const p of state.overview?.pending ?? []) {
      const title = state.manifest?.nodes[p.addr.node]?.title ?? p.addr.node;
      rows.push({ key: `p:${p.addr.node}`, color: "var(--ink)", title: p.addr.item ? `${p.addr.item.id} · ${title}` : title, what: p.status === "gate" ? "your call — approve it" : (p.hint ?? "waiting on your files"), since: null, go: () => onOpen({ kind: "step", addr: p.addr }) });
    }
    rows.sort((a, b) => (a.since ? Date.parse(a.since) : Infinity) - (b.since ? Date.parse(b.since) : Infinity));
    return rows;
  }, [blocks, state.overview, state.manifest, onOpen]);

  const past = blocks.flatMap((b) => b.lines.filter((l) => !active(l)).map((l) => ({ b, l })));

  if (!blocks.length) {
    return (
      <div className="map-empty">
        <div className="hand" style={{ fontSize: 22 }}>
          no lines yet
        </div>
        <p className="muted">
          A line is one item following a recipe, station by station. Teach the recipe first: distill it from the conversations you already had (the same kind of work done by hand), then put items on the timetable and let them depart.
        </p>
        <button className="primary" onClick={() => setDepot("new")}>
          <Pencil size={13} /> learn a recipe from my chats
        </button>
        {depot && <DepotPaper state={state} block={null} onClose={() => setDepot(null)} onError={onError} act={act} />}
      </div>
    );
  }

  return (
    <div className={`map-split ${selected ? "with-pane" : ""}`}>
      <div className="map-main">
        {board.length > 0 ? (
          <div className="board">
            <div className="board-h">
              <span className="pulse" /> needs you — {board.length}
            </div>
            {board.map((r) => (
              <div key={r.key} className="board-row" onClick={r.go}>
                <span className="t">{r.since ? ago(r.since) : "—"}</span>
                <span className="who">
                  <i className="ldot" style={{ background: r.color }} />
                  {r.title}
                </span>
                <span className="what">{r.what}</span>
                <span className="act">open →</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="board calm">
            <span className="muted small">nothing needs you — trains are moving or parked</span>
          </div>
        )}

        {blocks.map((b) => (
          <BlockMap key={b.id} state={state} block={b} sel={sel} onSelect={(item) => setSel({ foreach: b.id, item })} onJunction={() => setSheet(b.id)} onDepot={() => setDepot(b.id)} onOpen={onOpen} />
        ))}

        {past.length > 0 && (
          <div className="past">
            <button className="ghost small" onClick={() => setShowPast((v) => !v)}>
              {showPast ? "▾" : "▸"} past service · {past.length}
            </button>
            {showPast &&
              past.map(({ b, l }) => (
                <div key={`${b.id}/${l.item}`} className="past-row" onClick={() => setSel({ foreach: b.id, item: l.item })}>
                  <i className="ldot" style={{ background: lineColor(b, l.item) }} />
                  <span className={l.parked ? "strike muted" : ""}>{l.title}</span>
                  <span className="muted small">{l.parked ? "parked" : `arrived ${ago(l.line.updated)} ago`}</span>
                  {l.cost > 0 && <span className="muted small">≈${l.cost.toFixed(2)}</span>}
                </div>
              ))}
          </div>
        )}
        <div className="canvas-hint">click a train · click the junction for new departures · esc closes</div>
      </div>

      {selected && sel && <LinePane key={`${sel.foreach}/${sel.item}`} state={state} block={blocks.find((b) => b.id === sel.foreach)!} lv={selected} onClose={() => setSel(null)} onError={onError} act={act} />}
      {sheet && <DeparturesSheet state={state} block={blocks.find((b) => b.id === sheet)!} onClose={() => setSheet(null)} onError={onError} act={act} />}
      {depot && <DepotPaper state={state} block={depot === "new" ? null : (blocks.find((b) => b.id === depot) ?? null)} onClose={() => setDepot(null)} onError={onError} act={act} />}
    </div>
  );
}

/* ---------------- one lines block, as a map ---------------- */

function BlockMap({ state, block, sel, onSelect, onJunction, onDepot, onOpen }: { state: State; block: LinesView; sel: Sel | null; onSelect: (item: string) => void; onJunction: () => void; onDepot: () => void; onOpen: (t: OpenTarget) => void }) {
  const rows = block.lines.filter(active);
  const steps = block.recipe.steps;
  const maxSteps = Math.max(steps.length, ...rows.map((l) => l.steps.length), 1);
  const trunk = block.needs;
  const trunkX = (i: number) => LABEL_W + 30 + i * STN;
  const junctionX = LABEL_W + 30 + trunk.length * STN;
  const startX = junctionX + 90;
  const stX = (j: number) => startX + j * STN;
  const width = stX(maxSteps - 1) + 150;
  const rowY = (i: number) => TOP + i * ROW + 26;
  const height = TOP + Math.max(rows.length, 1) * ROW + 30;
  const jy = rows.length ? (rowY(0) + rowY(rows.length - 1)) / 2 : rowY(0);
  const ov = state.overview;
  const trunkStatus = (id: string): string => {
    const n = ov?.nodes.find((x) => x.id === id);
    if (n) return n.status;
    const fe = ov?.foreach.find((x) => x.id === id);
    if (fe) return fe.items.length && fe.items.every((it) => it.state === "done" || it.state === "skipped") ? "done" : fe.items.some((it) => it.state === "running") ? "running" : "pending";
    return "pending";
  };
  const trunkAddr = (id: string): NodeAddr | null => (state.manifest?.nodes[id] ? { node: id } : null);
  const notDeparted = block.timetable.filter((t) => !t.started).length;

  return (
    <div className="block">
      <div className="block-h">
        <span className="hand" style={{ fontSize: 17 }}>
          {block.recipe.title}
        </span>
        <span className="muted small">
          recipe v{block.liveVersion} · {steps.length} stations · {rows.length} in service{notDeparted ? ` · ${notDeparted} on the timetable` : ""}
        </span>
        <span className="grow" />
        <button className="ghost small" onClick={onDepot}>
          depot
        </button>
        <button className="ghost small" onClick={onJunction}>
          + departures
        </button>
      </div>
      <div className="map-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="linemap" role="img" aria-label={`${block.recipe.title}: ${rows.length} lines in service`}>
          {/* station labels + faint gridlines (video lines share stations) */}
          {steps.map((s, j) => (
            <g key={s.id}>
              <line x1={stX(j)} y1={TOP - 10} x2={stX(j)} y2={height - 20} stroke="var(--faint)" strokeWidth={1} />
              <text x={stX(j)} y={TOP - 18} textAnchor="middle" className={`stn-label ${s.gate === "you" ? "you" : ""}`}>
                {s.title.length > 14 ? s.title.slice(0, 13) + "…" : s.title}
              </text>
            </g>
          ))}
          {/* trunk */}
          {trunk.length > 0 && <line x1={trunkX(0) - 20} y1={jy} x2={junctionX} y2={jy} stroke="var(--ink)" strokeWidth={5} strokeLinecap="round" />}
          {trunk.length === 0 && <line x1={junctionX - 60} y1={jy} x2={junctionX} y2={jy} stroke="var(--ink)" strokeWidth={5} strokeLinecap="round" />}
          {trunk.map((id, i) => {
            const st = trunkStatus(id);
            const yours = st === "gate" || st === "waiting";
            const a = trunkAddr(id);
            return (
              <g key={id} className="trunk-stn" onClick={() => a && onOpen({ kind: "step", addr: a })} style={{ cursor: a ? "pointer" : "default" }}>
                {yours && <circle cx={trunkX(i)} cy={jy} r={14} fill="none" stroke="var(--accent)" strokeWidth={2.5} className="glow" />}
                <circle cx={trunkX(i)} cy={jy} r={7} fill={st === "done" || st === "cached" ? "var(--ink)" : "var(--card)"} stroke="var(--ink)" strokeWidth={3} className={st === "running" ? "moving" : ""} />
                <text x={trunkX(i)} y={jy + 24} textAnchor="middle" className="stn-label">
                  {state.manifest?.nodes[id]?.title ?? id}
                </text>
              </g>
            );
          })}
          {/* junction */}
          <g className="junction" onClick={onJunction} style={{ cursor: "pointer" }}>
            <circle cx={junctionX} cy={jy} r={16} fill="transparent" />
            <circle cx={junctionX} cy={jy} r={9} fill="var(--ink)" />
            <circle cx={junctionX} cy={jy} r={13} fill="none" stroke="var(--ink)" strokeWidth={1} opacity={0.35} />
            <text x={junctionX} y={jy + 30} textAnchor="middle" className="stn-label hand">
              {block.id}
            </text>
          </g>
          {rows.length === 0 && (
            <text x={startX + 10} y={jy + 5} className="stn-label hand">
              no lines in service — click the junction to start some
            </text>
          )}
          {/* lines */}
          {rows.map((l, i) => {
            const y = rowY(i);
            const color = lineColor(block, l.item);
            const n = l.steps.length;
            const cur = Math.min(l.line.step, n - 1);
            const isSel = sel?.foreach === block.id && sel.item === l.item;
            const waiting = l.line.state === "waiting";
            const failed = l.line.state === "failed";
            return (
              <g key={l.item} className={`line-row ${isSel ? "sel" : ""}`} onClick={() => onSelect(l.item)} style={{ cursor: "pointer" }}>
                <path d={`M ${junctionX} ${jy} C ${junctionX + 45} ${jy}, ${startX - 45} ${y}, ${startX} ${y}`} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" opacity={0.85} />
                <line x1={startX} y1={y} x2={stX(n - 1)} y2={y} stroke={color} strokeWidth={4} strokeLinecap="round" />
                {l.steps.map((s, j) => (
                  <circle key={s.id} cx={stX(j)} cy={y} r={4.5} fill={j < l.line.step ? color : "var(--card)"} stroke={color} strokeWidth={2.5} />
                ))}
                {waiting && <circle cx={stX(cur)} cy={y} r={15} fill="none" stroke="var(--accent)" strokeWidth={2.5} className="glow" />}
                {failed && <circle cx={stX(cur)} cy={y} r={15} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="4 3" />}
                <circle cx={stX(cur)} cy={y} r={9} fill={color} className={`train ${l.live ? "moving" : ""}`} style={{ transition: "cx .6s ease" }} />
                {isSel && <circle cx={stX(cur)} cy={y} r={12} fill="none" stroke="var(--ink)" strokeWidth={1.5} />}
                <text x={startX - 22} y={y - 4} textAnchor="end" className="line-name">
                  {l.title.length > 24 ? l.title.slice(0, 23) + "…" : l.title}
                </text>
                <text x={startX - 22} y={y + 11} textAnchor="end" className="line-sub">
                  {l.line.style ? `${l.line.style} · ` : ""}
                  {l.line.state === "failed" ? "went wrong" : l.live ? "working…" : waiting ? (l.gate === "you" ? "your station" : "your go") : l.steps[cur]?.title}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/* ---------------- the pane: one line, one click deep ---------------- */

function LinePane({ state, block, lv, onClose, onError, act }: { state: State; block: LinesView; lv: LineView; onClose: () => void; onError: (m: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const runId = state.overview?.run.id;
  const color = lineColor(block, lv.item);
  const n = lv.steps.length;
  const ls = lv.line;
  const cur = Math.min(ls.step, n - 1);
  const st = lv.steps[cur];
  const next = lv.steps[ls.step + 1];
  const done = ls.state === "done";
  const spec = state.manifest?.nodes[lv.addr.node];
  const body = { run: runId, foreach: lv.foreach, item: lv.item };
  const call = (route: string, extra: Record<string, unknown> = {}) => act(() => post(route, { ...body, ...extra }));

  let gateRow: React.ReactNode = null;
  if (done) gateRow = <div className="gate-row muted">arrived — every station done{lv.cost ? ` · ≈$${lv.cost.toFixed(2)}` : ""}</div>;
  else if (lv.parked) gateRow = <div className="gate-row muted">parked</div>;
  else if (lv.live) gateRow = <div className="gate-row muted">working on {st?.title}…</div>;
  else if (ls.state === "failed")
    gateRow = (
      <div className="gate-row">
        <span className="accent small">{ls.note}</span>
        <button className="small" onClick={() => call("/api/line-resume")}>
          try the station again
        </button>
        <button className="ghost small" onClick={() => call("/api/line-next")}>
          move on anyway
        </button>
      </div>
    );
  else if (ls.state === "waiting" && ls.note)
    gateRow = (
      <div className="gate-row">
        <span className="accent small">{ls.note}</span>
        <button className="small" onClick={() => call("/api/line-resume")}>
          resume the station
        </button>
        <button className="ghost small" onClick={() => call("/api/line-next")}>
          {next ? `next: ${next.title}` : "arrive"}
        </button>
      </div>
    );
  else if (ls.state === "waiting" && lv.gate === "you")
    gateRow = (
      <div className="gate-row">
        <span className="accent small">your station — what you say below moves the line on</span>
        <button className="ghost small" onClick={() => call("/api/line-next")}>
          move on without input
        </button>
      </div>
    );
  else if (ls.state === "waiting")
    gateRow = (
      <div className="gate-row">
        <button className="primary small" onClick={() => call("/api/line-next")}>
          <Play size={11} /> {next ? `next station: ${next.title}` : "arrive"}
        </button>
        <span className="muted small">or talk to it first</span>
      </div>
    );

  return (
    <div className="line-pane">
      <div className="strip" style={{ color }}>
        <div className="nm">
          <span style={{ color }}>● {lv.title}</span>
          <span className="stepword muted">{done ? "arrived" : `station ${cur + 1} of ${n} — ${st?.title ?? ""}${lv.gate === "you" && !done ? " · yours" : ""}`}</span>
          <span className="grow" />
          <span className="close-x" onClick={onClose} title="back to the map (esc)">
            <X />
          </span>
        </div>
        {lv.brief && <div className="muted small brief">{lv.brief}</div>}
        <div className="rail">
          <div className="track" />
          <div className="fill" style={{ width: `${(n > 1 ? cur / (n - 1) : 1) * 100}%`, background: color }} />
          {lv.steps.map((s, j) => (
            <span key={s.id} className={`stn ${j <= cur ? "on" : ""}`} style={{ left: `${(n > 1 ? j / (n - 1) : 0) * 100}%`, borderColor: j <= cur ? color : undefined }} title={`${j + 1}. ${s.title} (${s.gate})`} />
          ))}
          <span className={`tr ${ls.state === "waiting" ? "glow" : ""} ${lv.live ? "moving" : ""}`} style={{ left: `${(n > 1 ? cur / (n - 1) : 0) * 100}%`, background: color }} />
        </div>
      </div>
      {gateRow}
      {!done && !lv.live && ls.state !== "running" && block.liveVersion > ls.version && (
        <div className="gate-row muted">
          <span className="small">
            on recipe v{ls.version}; the file is now v{block.liveVersion}
          </span>
          <button className="ghost small" onClick={() => call("/api/line-update")} title="its remaining stations come from the new version; nothing already done changes">
            update this line
          </button>
        </div>
      )}
      <ChatView
        dir={state.dir}
        runId={runId}
        addr={lv.addr}
        refreshKey={0}
        model={spec && "model" in spec ? ((spec as { model?: string | null }).model ?? "") : ""}
        permissions="ask"
        onError={onError}
        externalBusy={lv.live}
        placeholder={lv.gate === "you" && ls.state === "waiting" ? "answer it — e.g. where the file is" : "talk to it"}
        emptyHint="the first station is on its way"
        style={{ flex: 1, minHeight: 0 }}
      />
      {!done && !lv.parked && (
        <div className="pane-foot">
          <button className="ghost small" onClick={() => act(() => post("/api/skip", { run: runId, foreach: lv.foreach, item: lv.item })).then(onClose)}>
            park this line
          </button>
          <span className="grow" />
          <span className="muted small">v{ls.version}{lv.cost ? ` · ≈$${lv.cost.toFixed(2)}` : ""}</span>
        </div>
      )}
      {lv.parked && (
        <div className="pane-foot">
          <button className="ghost small" onClick={() => act(() => post("/api/skip", { run: runId, foreach: lv.foreach, item: lv.item, undo: true }))}>
            bring it back
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- new departures ---------------- */

function DeparturesSheet({ state, block, onClose, onError, act }: { state: State; block: LinesView; onClose: () => void; onError: (m: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const styles = Object.keys(block.recipe.styles);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [style, setStyle] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const runId = state.overview?.run.id;
  const waiting = block.timetable.filter((t) => !t.started);
  const chosen = waiting.filter((t) => picked[t.id]);

  const start = async () => {
    setBusy(true);
    try {
      await post("/api/depart", { run: runId, foreach: block.id, picks: chosen.map((t) => ({ id: t.id, style: style[t.id] ?? block.recipe.defaultStyle ?? null })) });
      onClose();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = () =>
    act(async () => {
      const e = await post<{ id: string }>("/api/timetable-add", { run: runId, foreach: block.id, title, brief });
      setPicked((p) => ({ ...p, [e.id]: true }));
      setTitle("");
      setBrief("");
    });

  return (
    <div className="overlay" onClick={onClose}>
      <div className="paper" style={{ width: 560, marginTop: 40 }} onClick={(e) => e.stopPropagation()}>
        <div className="close" onClick={onClose}>
          <X />
        </div>
        <h1>new departures — {block.recipe.title}</h1>
        <div className="sub">
          recipe v{block.liveVersion} · each line opens as its own conversation, already at station 1{block.timetableError ? ` · timetable problem: ${block.timetableError}` : ""}
        </div>
        {waiting.length === 0 && <div className="muted small" style={{ margin: "8px 0" }}>everything on the timetable has departed — add an entry below</div>}
        {waiting.map((t) => (
          <div key={t.id} className="depart-row">
            <span className={`cb ${picked[t.id] ? "on" : ""}`} onClick={() => setPicked((p) => ({ ...p, [t.id]: !p[t.id] }))} />
            <span className="nm" onClick={() => setPicked((p) => ({ ...p, [t.id]: !p[t.id] }))}>
              {t.title}
              {t.brief && <span className="muted small"> — {t.brief}</span>}
            </span>
            {styles.length > 0 && (
              <select className="model-select" value={style[t.id] ?? block.recipe.defaultStyle ?? ""} onChange={(e) => setStyle((s) => ({ ...s, [t.id]: e.target.value }))} title="style for this line">
                {styles.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
        {block.timetable.filter((t) => t.started).length > 0 && (
          <div className="muted small" style={{ marginTop: 8 }}>
            already departed: {block.timetable.filter((t) => t.started).map((t) => t.title).join(", ")}
          </div>
        )}
        <div className="depart-add">
          <input placeholder="add an entry — its title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && void add()} />
          <input placeholder="one line of identity (optional)" value={brief} onChange={(e) => setBrief(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && void add()} />
          <button className="ghost" disabled={!title.trim()} onClick={() => void add()}>
            <Check size={13} />
          </button>
        </div>
        <div className="actions">
          <button className="primary" disabled={!chosen.length || busy} onClick={() => void start()}>
            <Play size={12} /> start {chosen.length || ""} line{chosen.length === 1 ? "" : "s"}
          </button>
          <button className="ghost" onClick={onClose}>
            never mind
          </button>
          <span className="grow" />
          <span className="pathline" style={{ margin: 0 }}>{block.listFile}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- the depot: the recipe, and learning one ---------------- */

function DepotPaper({ state, block, onClose, onError, act }: { state: State; block: LinesView | null; onClose: () => void; onError: (m: string) => void; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const recipe = block ? (state.manifest?.recipes?.[block.recipe.name] ?? block.recipe) : null;
  const chats = (state.overview?.nodes ?? []).filter((n) => (n.mode === "chat" || n.mode === "agent") && n.result?.session_id);
  const [name, setName] = useState(block?.recipe.name ?? "");
  const [from, setFrom] = useState<Record<string, boolean>>({});
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ version: number; stations: string[]; linesId: string | null } | null>(null);
  const runId = state.overview?.run.id;
  const picked = chats.filter((c) => from[c.id]);

  const learn = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await post<{ version: number; stations: string[]; linesId: string | null }>("/api/distill", { run: runId, name: name.trim(), chats: picked.map((c) => ({ node: c.id })), model: model || undefined });
      setResult(r);
      await act(async () => {});
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="paper" style={{ width: 620, marginTop: 30 }} onClick={(e) => e.stopPropagation()}>
        <div className="close" onClick={onClose}>
          <X />
        </div>
        <h1>depot{recipe ? ` — ${recipe.title}` : ""}</h1>
        <div className="sub">where the recipe lives · it changes by learning from conversations, never by hand</div>
        {recipe && (
          <>
            <div className="muted small">
              v{recipe.version}
              {block && block.lines.some((l) => active(l) && l.line.version !== recipe.version) ? " · lines already on the track finish on the version they departed with" : ""}
            </div>
            <div className="steps">
              {recipe.steps.map((s, i) => (
                <div key={s.id} className="step" title={s.body}>
                  <span className="muted small" style={{ width: 18 }}>
                    {i + 1}
                  </span>
                  <span style={{ flex: 1 }}>{s.title}</span>
                  <span className={`chip faint ${s.gate === "you" ? "accent" : ""}`}>{s.gate === "you" ? "you" : s.gate === "auto" ? "auto" : "your go"}</span>
                  {s.expects.length > 0 && <span className="muted small">→ {s.expects.join(", ")}</span>}
                </div>
              ))}
            </div>
            {Object.keys(recipe.styles).length > 0 && (
              <div className="chips" style={{ marginTop: 10 }}>
                {Object.entries(recipe.styles).map(([k, v]) => (
                  <span key={k} className={`chip ${k === recipe.defaultStyle ? "" : "faint"}`} title={v}>
                    {k}
                    {k === recipe.defaultStyle ? " · default" : ""}
                  </span>
                ))}
              </div>
            )}
            {recipe.preamble && (
              <details>
                <summary>the rules that hold at every station</summary>
                <pre>{recipe.preamble}</pre>
              </details>
            )}
            <div className="pathline">{recipe.file}</div>
          </>
        )}

        <h3 className="hand" style={{ margin: "18px 0 2px", fontSize: 15 }}>
          {recipe ? "learn a newer version from conversations" : "learn a recipe from conversations"}
        </h3>
        <div className="sub">pick the chats where this kind of work was done by hand; the spine they share becomes the stations, your corrections become the rules</div>
        <label>
          <span>recipe name</span>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))} placeholder="e.g. shorts" disabled={!!recipe} />
        </label>
        {chats.length === 0 && <div className="muted small">no finished conversations in this run yet</div>}
        {chats.map((c) => (
          <div key={c.id} className="depart-row" onClick={() => setFrom((f) => ({ ...f, [c.id]: !f[c.id] }))}>
            <span className={`cb ${from[c.id] ? "on" : ""}`} />
            <span className="nm">
              {c.title}
              <span className="muted small"> · {c.result?.turns ?? "?"} turns{c.result?.cost_usd ? ` · ≈$${c.result.cost_usd.toFixed(2)}` : ""}</span>
            </span>
          </div>
        ))}
        <div className="actions">
          <button className="primary" disabled={!name.trim() || !picked.length || busy} onClick={() => void learn()}>
            <Pencil size={12} /> {busy ? "distilling… (a few minutes)" : recipe ? `learn v${recipe.version + 1}` : "learn the recipe"}
          </button>
          <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} title="model for the distiller">
            <option value="">model: default</option>
            <option value="opus">opus</option>
            <option value="sonnet">sonnet</option>
          </select>
          <button className="ghost" onClick={onClose}>
            close
          </button>
        </div>
        {result && (
          <div className="muted small" style={{ marginTop: 8 }}>
            learned v{result.version}: {result.stations.join(" → ")}
            {result.linesId ? ` · lines "${result.linesId}" added — put entries on its timetable and depart` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
