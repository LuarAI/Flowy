import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { get, post, type Manifest, type NodeAddr, type State } from "./client";
import { collectSources, humanMode, humanStatus, itemWorst, placeholderView, NEEDS_YOU, WRONG, type SourcePill } from "./model";
import { Play, X } from "./icons";

/*
 * The canvas IS Excalidraw (the real, embedded editor). Flowy draws the
 * workflow as ordinary Excalidraw elements (ids prefixed `fl-`) and maps the
 * native gestures back onto the files:
 *   draw a rectangle            -> becomes a step (a small form asks its name)
 *   draw an arrow card -> card  -> a dependency edge (needs:)
 *   draw an arrow pill -> card  -> attach that context file to the step
 *   Delete on a card/arrow      -> remove the node / edge / context
 *   drag                        -> positions persist (layout.canvas / sketch)
 * Anything else you draw or write is yours and persists in
 * sketch.excalidraw.json next to the workflow.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type ExEl = Record<string, any>;
interface ExAPI {
  updateScene(o: { elements?: readonly ExEl[]; captureUpdate?: unknown }): void;
  getSceneElements(): readonly ExEl[];
  getAppState(): any;
}

const INK = "#2b2925";
const MUTED = "#8a857c";
const ACCENT = "#c2410c";
const ACCENT_WASH = "#fdebdd";
const CARD_BG = "#fffdf9";

interface Sketch {
  elements: ExEl[];
  sources: Record<string, { x: number; y: number }>;
}

export interface OpenTarget {
  kind: "step" | "item" | "checklist";
  addr?: NodeAddr;
  foreach?: string;
  id?: string;
}

interface Props {
  state: State;
  onOpen: (t: OpenTarget) => void;
  onError: (msg: string) => void;
}

interface PendingBox {
  rawId: string;
  x: number;
  y: number;
}

export function ExCanvas({ state, onOpen, onError }: Props) {
  const apiRef = useRef<ExAPI | null>(null);
  const sketchRef = useRef<Sketch>({ elements: [], sources: {} });
  const sketchLoaded = useRef(false);
  const lastPos = useRef<Record<string, { x: number; y: number }>>({});
  const expectedFl = useRef<Map<string, ExEl>>(new Map());
  const consumed = useRef<Set<string>>(new Set());
  const knownUser = useRef<Set<string>>(new Set());
  const suppressUntil = useRef(0);
  const pointerDown = useRef(false);
  const rebuildQueued = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sketchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingBox, setPendingBox] = useState<PendingBox | null>(null);
  const [boxName, setBoxName] = useState("");
  const [boxKind, setBoxKind] = useState<"chat" | "agent" | "wait" | "script">("chat");
  const [chip, setChip] = useState<{ x: number; y: number; target: OpenTarget; label: string } | null>(null);

  const sources = useMemo(() => (state.manifest ? collectSources(state.manifest) : []), [state.manifest]);

  /* ---------- build the flowy elements ---------- */

  const build = useCallback((): ExEl[] => {
    const m = state.manifest;
    if (!m) return [];
    const ov = state.overview;
    const layoutPos = new Map((state.layout?.nodes ?? []).map((n) => [n.id, { x: n.x, y: n.y }]));
    const viewById = new Map((ov?.nodes ?? []).map((n) => [n.id, n]));
    const feById = new Map((ov?.foreach ?? []).map((f) => [f.id, f]));
    const skeletons: any[] = [];
    const centers = new Map<string, { x: number; y: number; w: number; h: number }>();
    const posOf = (id: string, i: number) => layoutPos.get(id) ?? { x: 340, y: i * 190 };

    for (const [i, id] of m.top.entries()) {
      const p = posOf(id, i);
      if (id in m.foreach) {
        const fe = feById.get(id);
        const items = fe?.items ?? [];
        const lines = items.length
          ? items.map((it) => {
              const w = itemWorst(it);
              const parked = it.state === "skipped" || it.state === "orphaned";
              const mark = w.status === "done" ? "✓" : parked ? "—" : w.view && (NEEDS_YOU.includes(w.view.status) || WRONG.includes(w.view.status)) ? "→" : "○";
              return `${mark} ${it.id}${w.status === "done" || parked ? "" : `  · ${w.status}`}`;
            })
          : ["(the list appears when the step above finishes)"];
        const anyYours = items.some((it) => {
          const w = itemWorst(it);
          return w.view && (NEEDS_YOU.includes(w.view.status) || WRONG.includes(w.view.status));
        });
        const h = 56 + lines.length * 25;
        const w = 340;
        skeletons.push({
          type: "rectangle",
          id: `fl-fe-${id}`,
          x: p.x,
          y: p.y,
          width: w,
          height: h,
          strokeColor: anyYours ? ACCENT : INK,
          backgroundColor: anyYours ? ACCENT_WASH : CARD_BG,
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "dashed",
          roughness: 1,
          customData: { flowy: { kind: "checklist", id } },
          label: { text: `${id} — checklist\n${lines.join("\n")}`, fontSize: 15, fontFamily: 1, textAlign: "left", verticalAlign: "top", strokeColor: anyYours ? ACCENT : INK },
        });
        centers.set(id, { x: p.x, y: p.y, w, h });
      } else {
        const v = viewById.get(id) ?? placeholderView(m, id);
        const yours = NEEDS_YOU.includes(v.status);
        const wrong = WRONG.includes(v.status);
        const title = `${v.status === "done" ? "✓ " : ""}${v.title}${v.status === "running" ? " …" : ""}`;
        const subBits = [humanMode(v.mode, v.recipe)];
        if (v.result?.duration_ms) subBits.push(`${Math.round(v.result.duration_ms / 1000)}s`);
        if (v.status === "stale") subBits.push("needs a refresh");
        let text = `${title}\n${subBits.join(" · ")}`;
        if (yours) text += `\n→ ${v.hint ?? (v.status === "gate" ? "your call — open it" : "waiting on you")}`;
        if (wrong) text += `\n→ went wrong — open it`;
        const h = 66 + (yours || wrong ? 25 : 0);
        const w = 236;
        skeletons.push({
          type: "rectangle",
          id: `fl-node-${id}`,
          x: p.x,
          y: p.y,
          width: w,
          height: h,
          strokeColor: yours || wrong ? ACCENT : INK,
          backgroundColor: yours || wrong ? ACCENT_WASH : CARD_BG,
          fillStyle: "solid",
          strokeWidth: 1,
          roughness: 1,
          opacity: v.status === "pending" && !v.version ? 55 : 100,
          customData: { flowy: { kind: "step", id } },
          label: { text, fontSize: 15, fontFamily: 1, textAlign: "left", verticalAlign: "top", strokeColor: yours || wrong ? ACCENT : INK },
        });
        centers.set(id, { x: p.x, y: p.y, w, h });
      }
    }

    // source pills
    sources.forEach((s, i) => {
      const first = s.targets.map((t) => centers.get(t)).find(Boolean);
      const saved = sketchRef.current.sources[s.key];
      const p = saved ?? { x: (first?.x ?? 340) - 300, y: (first?.y ?? 40) + i * 88 };
      skeletons.push({
        type: "rectangle",
        id: `fl-src-${i}`,
        x: p.x,
        y: p.y,
        width: 204,
        height: 58,
        strokeColor: MUTED,
        backgroundColor: CARD_BG,
        fillStyle: "solid",
        strokeWidth: 1,
        roughness: 1,
        customData: { flowy: { kind: "source", key: s.key, entry: s.entry } },
        label: { text: `▣ ${s.label}\n${s.sub}`, fontSize: 13, fontFamily: 1, textAlign: "left", verticalAlign: "top", strokeColor: MUTED },
      });
      centers.set(`src-${i}`, { x: p.x, y: p.y, w: 204, h: 58 });
      for (const t of s.targets) {
        if (!centers.has(t)) continue;
        skeletons.push(arrowSkeleton(`fl-ctx-${i}--${t}`, centers.get(`src-${i}`)!, centers.get(t)!, MUTED, "dashed"));
      }
    });

    // dependency edges among top-level vertices
    const topSet = new Set(m.top);
    const seen = new Set<string>();
    for (const e of m.edges) {
      if (!topSet.has(e.from) || !topSet.has(e.to)) continue;
      const id = `fl-edge-${e.from}--${e.to}`;
      if (seen.has(id) || !centers.has(e.from) || !centers.has(e.to)) continue;
      seen.add(id);
      skeletons.push(arrowSkeleton(id, centers.get(e.from)!, centers.get(e.to)!, INK, "solid"));
    }

    const els = convertToExcalidrawElements(skeletons, { regenerateIds: false }) as ExEl[];
    expectedFl.current = new Map(els.map((el) => [el.id, el]));
    lastPos.current = {};
    for (const [id, c] of centers) if (!id.startsWith("src-")) lastPos.current[id] = { x: c.x, y: c.y };
    return els;
  }, [state, sources]);

  /* ---------- push the scene ---------- */

  const rebuild = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    if (pointerDown.current) {
      rebuildQueued.current = true;
      return;
    }
    const current = api.getSceneElements();
    const currentUser = current.filter((el) => !String(el.id).startsWith("fl-") && !el.isDeleted && !consumed.current.has(el.id));
    const user = sketchLoaded.current && currentUser.length === 0 && sketchRef.current.elements.length > 0 && current.length === 0 ? sketchRef.current.elements : currentUser;
    knownUser.current = new Set(user.map((el) => el.id));
    suppressUntil.current = Date.now() + 400;
    api.updateScene({ elements: [...build(), ...user], captureUpdate: CaptureUpdateAction.NEVER });
  }, [build]);

  // load the sketch once, then keep the scene in step with the state
  useEffect(() => {
    let live = true;
    if (!sketchLoaded.current) {
      get<Sketch>("/api/sketch")
        .then((s) => {
          if (!live) return;
          sketchRef.current = { elements: s.elements ?? [], sources: s.sources ?? {} };
          sketchLoaded.current = true;
          const api = apiRef.current;
          if (api) {
            suppressUntil.current = Date.now() + 400;
            api.updateScene({ elements: [...build(), ...sketchRef.current.elements], captureUpdate: CaptureUpdateAction.NEVER });
            knownUser.current = new Set(sketchRef.current.elements.map((el) => el.id));
          }
        })
        .catch(() => (sketchLoaded.current = true));
    } else rebuild();
    return () => {
      live = false;
    };
  }, [rebuild, build]);

  const saveSketch = useCallback(() => {
    if (sketchTimer.current) clearTimeout(sketchTimer.current);
    sketchTimer.current = setTimeout(() => {
      void post("/api/sketch", sketchRef.current as unknown as Record<string, unknown>).catch(() => {});
    }, 1200);
  }, []);

  /* ---------- interpret what the human did ---------- */

  const process = useCallback(() => {
    const api = apiRef.current;
    if (!api || Date.now() < suppressUntil.current) return;
    const els = api.getSceneElements();
    const appState = api.getAppState();
    const alive = new Map(els.filter((el) => !el.isDeleted).map((el) => [String(el.id), el]));
    const m = state.manifest;
    if (!m) return;

    // 1. moved cards -> layout; moved pills -> sketch.sources
    const movedLayout: Record<string, { x: number; y: number }> = {};
    for (const [flId, el] of alive) {
      if (flId.startsWith("fl-node-") || flId.startsWith("fl-fe-")) {
        const id = flId.replace(/^fl-(node|fe)-/, "");
        const last = lastPos.current[id];
        if (last && (Math.abs(el.x - last.x) > 1 || Math.abs(el.y - last.y) > 1)) {
          movedLayout[id] = { x: el.x, y: el.y };
          lastPos.current[id] = { x: el.x, y: el.y };
        }
      } else if (flId.startsWith("fl-src-")) {
        const idx = parseInt(flId.slice(7), 10);
        const s = sources[idx];
        if (s) {
          const prev = sketchRef.current.sources[s.key];
          if (!prev || Math.abs(prev.x - el.x) > 1 || Math.abs(prev.y - el.y) > 1) {
            sketchRef.current.sources[s.key] = { x: el.x, y: el.y };
            saveSketch();
          }
        }
      }
    }
    if (Object.keys(movedLayout).length) void post("/api/layout", { positions: movedLayout }).catch((e) => onError(e.message));

    // 2. deletions of flowy elements
    for (const [flId] of expectedFl.current) {
      if (alive.has(flId)) continue;
      if (flId.startsWith("fl-edge-")) {
        const [from, to] = flId.slice(8).split("--");
        expectedFl.current.delete(flId);
        void post("/api/graph/edge", { op: "remove", from, to }).catch((e) => {
          onError(e.message);
          rebuild();
        });
      } else if (flId.startsWith("fl-ctx-")) {
        const [idxS, node] = flId.slice(7).split("--");
        const s = sources[parseInt(idxS, 10)];
        expectedFl.current.delete(flId);
        if (s) void post("/api/graph/context", { op: "remove", node, entry: s.entry }).catch((e) => {
          onError(e.message);
          rebuild();
        });
      } else if (flId.startsWith("fl-node-")) {
        const id = flId.slice(8);
        expectedFl.current.delete(flId);
        if (window.confirm(`Delete the step "${id}" and its file? (its past runs stay on disk)`)) {
          void post("/api/graph/node", { op: "remove", id }).catch((e) => {
            onError(e.message);
            rebuild();
          });
        } else rebuild();
      } else if (flId.startsWith("fl-fe-")) {
        expectedFl.current.delete(flId);
        onError("a checklist can't be deleted from the canvas — remove the foreach block in workflow.yaml");
        rebuild();
      } else {
        expectedFl.current.delete(flId); // bound text of a deleted card; nothing to do
      }
    }

    // 3. new arrows the human drew between flowy elements
    for (const [id, el] of alive) {
      if (el.type !== "arrow" || id.startsWith("fl-") || consumed.current.has(id) || knownUser.current.has(id)) continue;
      const from = String(el.startBinding?.elementId ?? "");
      const to = String(el.endBinding?.elementId ?? "");
      const toNode = to.startsWith("fl-node-") ? to.slice(8) : to.startsWith("fl-fe-") ? to.slice(6) : null;
      if (toNode && (from.startsWith("fl-node-") || from.startsWith("fl-fe-"))) {
        consumed.current.add(id);
        const fromId = from.replace(/^fl-(node|fe)-/, "");
        void post("/api/graph/edge", { op: "add", from: fromId, to: toNode }).catch((e) => {
          onError(e.message);
          consumed.current.delete(id);
          rebuild();
        });
      } else if (toNode && from.startsWith("fl-src-")) {
        const s = sources[parseInt(from.slice(7), 10)];
        if (s) {
          consumed.current.add(id);
          void post("/api/graph/context", { op: "add", node: toNode, entry: s.entry }).catch((e) => {
            onError(e.message);
            consumed.current.delete(id);
            rebuild();
          });
        }
      }
    }

    // 4. a fresh box the human drew -> offer to make it a step
    if (!pendingBox) {
      for (const [id, el] of alive) {
        if (!["rectangle", "diamond", "ellipse"].includes(String(el.type)) || id.startsWith("fl-") || knownUser.current.has(id) || consumed.current.has(id)) continue;
        if ((el.width ?? 0) * (el.height ?? 0) < 2500) continue;
        setPendingBox({ rawId: id, x: el.x, y: el.y });
        setBoxName("");
        break;
      }
    }

    // 5. everything else the human drew/wrote is sketch — persist it
    const userEls = [...alive.values()].filter((el) => !String(el.id).startsWith("fl-") && !consumed.current.has(el.id) && el.id !== pendingBox?.rawId);
    const serialized = JSON.stringify(userEls.map((e) => e.id + ":" + e.version));
    if (serialized !== (sketchRef.current as any)._sig) {
      (sketchRef.current as any)._sig = serialized;
      sketchRef.current.elements = userEls as ExEl[];
      for (const el of userEls) knownUser.current.add(el.id);
      saveSketch();
    }

    // 6. selection chip
    const sel = Object.keys(appState.selectedElementIds ?? {}).filter((k) => appState.selectedElementIds[k]);
    if (sel.length === 1 && (sel[0].startsWith("fl-node-") || sel[0].startsWith("fl-fe-"))) {
      const el = alive.get(sel[0]);
      if (el) {
        const zoom = appState.zoom?.value ?? 1;
        const x = (el.x + el.width + appState.scrollX) * zoom;
        const y = (el.y + appState.scrollY) * zoom;
        const target: OpenTarget = sel[0].startsWith("fl-node-") ? { kind: "step", addr: { node: sel[0].slice(8) } } : { kind: "checklist", foreach: sel[0].slice(6) };
        setChip({ x, y, target, label: "open" });
      }
    } else setChip(null);
  }, [state.manifest, sources, pendingBox, rebuild, saveSketch, onError]);

  const onChange = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(process, 350);
  }, [process]);

  const createStep = async () => {
    if (!pendingBox || !boxName.trim()) return;
    const id = boxName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!id) return;
    consumed.current.add(pendingBox.rawId);
    try {
      await post("/api/graph/node", { id, mode: boxKind, title: boxName.trim() });
      await post("/api/layout", { positions: { [id]: { x: pendingBox.x, y: pendingBox.y } } });
    } catch (e) {
      onError((e as Error).message);
      consumed.current.delete(pendingBox.rawId);
    }
    setPendingBox(null);
  };

  return (
    <div style={{ position: "absolute", inset: 0 }} onPointerDownCapture={() => (pointerDown.current = true)} onPointerUpCapture={() => {
      pointerDown.current = false;
      if (rebuildQueued.current) {
        rebuildQueued.current = false;
        setTimeout(rebuild, 100);
      }
    }}>
      <Excalidraw
        excalidrawAPI={(api: unknown) => {
          apiRef.current = api as ExAPI;
          rebuild();
        }}
        onChange={onChange}
        initialData={{ appState: { viewBackgroundColor: "#f6f4ee", currentItemFontFamily: 1, currentItemStrokeColor: INK }, scrollToContent: true }}
        UIOptions={{ canvasActions: { loadScene: false, clearCanvas: false, export: false, toggleTheme: false } }}
      />
      {chip && (
        <button className="open-chip" style={{ left: chip.x + 8, top: chip.y - 6 }} onClick={() => onOpen(chip.target)}>
          {chip.label} →
        </button>
      )}
      <div className="canvas-hint">draw a box = new step · arrow = connect · Del = remove · scribbles are yours and stay</div>
      {pendingBox && (
        <div className="overlay" onClick={() => { knownUser.current.add(pendingBox.rawId); setPendingBox(null); }}>
          <div className="paper" style={{ width: 420, marginTop: 60 }} onClick={(e) => e.stopPropagation()}>
            <div className="close" onClick={() => { knownUser.current.add(pendingBox.rawId); setPendingBox(null); }}>
              <X />
            </div>
            <h1>make this box a step?</h1>
            <div className="sub">or close this and it stays a sketch</div>
            <label>
              <span>what happens here?</span>
              <input autoFocus value={boxName} onChange={(e) => setBoxName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createStep()} placeholder="e.g. Pick the hooks" />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
              {(
                [
                  ["chat", "we do it together"],
                  ["agent", "Claude does it"],
                  ["wait", "I do it myself"],
                  ["script", "runs a tool"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={boxKind === k ? "primary" : ""} onClick={() => setBoxKind(k)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="actions">
              <button className="primary" onClick={createStep} disabled={!boxName.trim()}>
                <Play size={12} color="#fffdf9" /> create the step
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function arrowSkeleton(id: string, a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, color: string, style: "solid" | "dashed") {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h;
  const bx = b.x + b.w / 2;
  const by = b.y;
  return {
    type: "arrow",
    id,
    x: ax,
    y: ay,
    width: bx - ax,
    height: by - ay,
    strokeColor: color,
    strokeWidth: 1,
    strokeStyle: style,
    roughness: 1,
    start: { id: idOfCenter(a, id, true) },
    end: { id: idOfCenter(b, id, false) },
  };
}

// arrows bind to the elements by id; the centers map used element rect ids
function idOfCenter(_c: unknown, arrowId: string, isStart: boolean): string {
  // fl-edge-a--b / fl-ctx-i--b encode both endpoint ids
  if (arrowId.startsWith("fl-edge-")) {
    const [from, to] = arrowId.slice(8).split("--");
    return isStart ? flIdFor(from) : flIdFor(to);
  }
  const [idx, to] = arrowId.slice(7).split("--");
  return isStart ? `fl-src-${idx}` : flIdFor(to);
}

let manifestTops: Set<string> = new Set();
export function setFeIds(m: Manifest | null) {
  manifestTops = new Set(m ? Object.keys(m.foreach) : []);
}
function flIdFor(id: string): string {
  return manifestTops.has(id) ? `fl-fe-${id}` : `fl-node-${id}`;
}
