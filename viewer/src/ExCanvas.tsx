import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, MainMenu, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { get, post, type Manifest, type NodeAddr, type State } from "./client";
import { collectSources, entryFor, humanMode, itemWorst, placeholderView, NEEDS_YOU, WRONG } from "./model";
import { Play, X } from "./icons";

/*
 * The canvas IS Excalidraw. Flowy draws the workflow as ordinary elements
 * (containers carry ids prefixed `fl-`; their bound labels are recognized by
 * customData/containerId) and maps native gestures back onto the files:
 *   draw a rectangle            -> becomes a step (a small form asks its name)
 *   draw an arrow card -> card  -> a dependency edge (needs:)
 *   draw an arrow pill -> card  -> attach that context file to the step
 *   Delete on a card/arrow      -> remove the node / edge / context
 *   drag                        -> positions persist
 * Everything else the human draws or writes persists in sketch.excalidraw.json.
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

/** Anything Flowy generated: the container (fl- id), its bound label, or anything tagged. */
function isFlowyOwned(el: ExEl): boolean {
  const id = String(el.id ?? "");
  if (id.startsWith("fl-")) return true;
  if (el.customData && (el.customData as any).flowy) return true;
  if (el.containerId && String(el.containerId).startsWith("fl-")) return true;
  return false;
}

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
  const sketchSig = useRef("");
  const sketchLoaded = useRef(false);
  const lastPos = useRef<Record<string, { x: number; y: number }>>({});
  const expectedFl = useRef<Map<string, ExEl>>(new Map());
  const consumed = useRef<Set<string>>(new Set());
  const knownUser = useRef<Set<string>>(new Set());
  const suppressUntil = useRef(0);
  const pointerDown = useRef(false);
  const rebuildQueued = useRef(false);
  const busy = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sketchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pendingBox, setPendingBox] = useState<PendingBox | null>(null);
  const [boxName, setBoxName] = useState("");
  const [boxKind, setBoxKind] = useState<"chat" | "agent" | "wait" | "script">("chat");
  const [chip, setChip] = useState<{ x: number; y: number; target: OpenTarget } | null>(null);

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
    const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
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
        boxes.set(id, { x: p.x, y: p.y, w, h });
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
        boxes.set(id, { x: p.x, y: p.y, w, h });
      }
    }

    // source pills (one per file)
    sources.forEach((s, i) => {
      const first = s.targets.map((t) => boxes.get(t.id)).find(Boolean);
      const saved = sketchRef.current.sources[s.key];
      const p = saved ?? { x: (first?.x ?? 340) - 300, y: (first?.y ?? 40) + i * 92 };
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
        customData: { flowy: { kind: "source", key: s.key } },
        label: { text: `▣ ${s.label}\n${s.sub}`, fontSize: 13, fontFamily: 1, textAlign: "left", verticalAlign: "top", strokeColor: MUTED },
      });
      boxes.set(`__src${i}`, { x: p.x, y: p.y, w: 204, h: 58 });
      for (const t of s.targets) {
        if (!boxes.has(t.id)) continue;
        skeletons.push(arrowSkeleton(`fl-ctx-${i}--${t.id}`, boxes.get(`__src${i}`)!, boxes.get(t.id)!, MUTED, "dashed", m));
      }
    });

    // dependency edges among top-level vertices
    const topSet = new Set(m.top);
    const seen = new Set<string>();
    for (const e of m.edges) {
      if (!topSet.has(e.from) || !topSet.has(e.to)) continue;
      const id = `fl-edge-${e.from}--${e.to}`;
      if (seen.has(id) || !boxes.has(e.from) || !boxes.has(e.to)) continue;
      seen.add(id);
      skeletons.push(arrowSkeleton(id, boxes.get(e.from)!, boxes.get(e.to)!, INK, "solid", m));
    }

    let els: ExEl[] = [];
    try {
      els = convertToExcalidrawElements(skeletons, { regenerateIds: false }) as ExEl[];
    } catch (e) {
      onError(`canvas build failed: ${(e as Error).message}`);
      return [];
    }
    expectedFl.current = new Map(els.filter((el) => String(el.id).startsWith("fl-")).map((el) => [el.id, el]));
    lastPos.current = {};
    for (const [id, c] of boxes) if (!id.startsWith("__src")) lastPos.current[id] = { x: c.x, y: c.y };
    return els;
  }, [state, sources, onError]);

  /* ---------- push the scene ---------- */

  const rebuild = useCallback(() => {
    const api = apiRef.current;
    if (!api || !state.manifest) return;
    if (pointerDown.current || busy.current) {
      rebuildQueued.current = true;
      return;
    }
    const current = api.getSceneElements();
    const user = current.filter((el) => !isFlowyOwned(el) && !el.isDeleted && !consumed.current.has(el.id));
    knownUser.current = new Set(user.map((el) => el.id));
    suppressUntil.current = Date.now() + 400;
    api.updateScene({ elements: [...build(), ...user], captureUpdate: CaptureUpdateAction.NEVER });
  }, [build, state.manifest]);

  // load the sketch once, then keep the scene in step with the state
  useEffect(() => {
    let live = true;
    if (!sketchLoaded.current) {
      get<Sketch>("/api/sketch")
        .then((s) => {
          if (!live) return;
          // drop any zombie flowy leftovers a previous version may have saved
          sketchRef.current = { elements: (s.elements ?? []).filter((el) => !isFlowyOwned(el)), sources: s.sources ?? {} };
          sketchLoaded.current = true;
          const api = apiRef.current;
          if (api && state.manifest) {
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
  }, [rebuild, build, state.manifest]);

  const saveSketch = useCallback(() => {
    if (sketchTimer.current) clearTimeout(sketchTimer.current);
    sketchTimer.current = setTimeout(() => {
      void post("/api/sketch", sketchRef.current as unknown as Record<string, unknown>).catch(() => {});
    }, 1200);
  }, []);

  /* ---------- interpret what the human did ---------- */

  const process = useCallback(async () => {
    const api = apiRef.current;
    if (!api || busy.current || Date.now() < suppressUntil.current) return;
    // While the workflow doesn't compile, the canvas is a picture, not an editor.
    if (state.compileError) return;
    const m = state.manifest;
    if (!m) return;
    busy.current = true;
    try {
      const els = api.getSceneElements();
      const appState = api.getAppState();
      const alive = new Map(els.filter((el) => !el.isDeleted).map((el) => [String(el.id), el]));
      const errors: string[] = [];
      let mustRebuild = false;

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
          const s = sources[parseInt(flId.slice(7), 10)];
          if (s) {
            const prev = sketchRef.current.sources[s.key];
            if (!prev || Math.abs(prev.x - el.x) > 1 || Math.abs(prev.y - el.y) > 1) {
              sketchRef.current.sources[s.key] = { x: el.x, y: el.y };
              saveSketch();
            }
          }
        }
      }
      if (Object.keys(movedLayout).length) await post("/api/layout", { positions: movedLayout }).catch((e) => errors.push(e.message));

      // 2. deletions — one batch. Deleting a card auto-deletes its arrows and
      //    label; those are not separate intentions.
      const deleted = [...expectedFl.current.keys()].filter((flId) => !alive.has(flId));
      if (deleted.length) {
        const deletedCards = new Set(deleted.filter((d) => /^fl-(node|fe)-/.test(d)).map((d) => d.replace(/^fl-(node|fe)-/, "")));
        const deletedSrcs = new Set(deleted.filter((d) => d.startsWith("fl-src-")).map((d) => d.slice(7)));
        const isCascade = (flId: string): boolean => {
          if (flId.startsWith("fl-edge-")) {
            const [a, b] = flId.slice(8).split("--");
            return deletedCards.has(a) || deletedCards.has(b);
          }
          if (flId.startsWith("fl-ctx-")) {
            const [idxS, node] = flId.slice(7).split("--");
            return deletedCards.has(node) || deletedSrcs.has(idxS);
          }
          return false;
        };
        for (const flId of deleted) expectedFl.current.delete(flId);

        const nodeDeletes = deleted.filter((d) => d.startsWith("fl-node-")).map((d) => d.slice(8));
        const edgeDeletes = deleted.filter((d) => d.startsWith("fl-edge-") && !isCascade(d));
        const ctxDeletes = deleted.filter((d) => d.startsWith("fl-ctx-") && !isCascade(d));
        if (deleted.some((d) => d.startsWith("fl-fe-"))) {
          errors.push("a checklist can't be deleted from the canvas yet — remove the foreach block in workflow.yaml");
          mustRebuild = true;
        }
        if (deleted.some((d) => d.startsWith("fl-src-"))) {
          errors.push("source pills follow the steps that read them — delete their dashed arrows to detach the file");
          mustRebuild = true;
        }
        for (const flId of edgeDeletes) {
          const [from, to] = flId.slice(8).split("--");
          await post("/api/graph/edge", { op: "remove", from, to }).catch((e) => {
            errors.push(e.message);
            mustRebuild = true;
          });
        }
        for (const flId of ctxDeletes) {
          const [idxS, node] = flId.slice(7).split("--");
          const s = sources[parseInt(idxS, 10)];
          const entry = s?.targets.find((t) => t.id === node)?.entry;
          if (entry)
            await post("/api/graph/context", { op: "remove", node, entry }).catch((e) => {
              errors.push(e.message);
              mustRebuild = true;
            });
        }
        if (nodeDeletes.length) {
          const ok = window.confirm(
            nodeDeletes.length === 1 ? `Delete the step "${nodeDeletes[0]}" and its file? (past runs stay on disk)` : `Delete ${nodeDeletes.length} steps (${nodeDeletes.join(", ")}) and their files?`,
          );
          if (ok) {
            for (const id of nodeDeletes) {
              await post("/api/graph/node", { op: "remove", id }).catch((e) => {
                errors.push(e.message);
                mustRebuild = true;
              });
            }
          } else mustRebuild = true;
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
          await post("/api/graph/edge", { op: "add", from: fromId, to: toNode }).catch((e) => {
            errors.push(e.message);
            consumed.current.delete(id);
            mustRebuild = true;
          });
        } else if (toNode && from.startsWith("fl-src-")) {
          const s = sources[parseInt(from.slice(7), 10)];
          if (s) {
            consumed.current.add(id);
            await post("/api/graph/context", { op: "add", node: toNode, entry: entryFor(s, toNode, m) }).catch((e) => {
              errors.push(e.message);
              consumed.current.delete(id);
              mustRebuild = true;
            });
          }
        }
      }

      // 4. a fresh box the human drew -> offer to make it a step
      if (!pendingBox) {
        for (const [id, el] of alive) {
          if (!["rectangle", "diamond", "ellipse"].includes(String(el.type)) || isFlowyOwned(el) || knownUser.current.has(id) || consumed.current.has(id)) continue;
          if ((el.width ?? 0) * (el.height ?? 0) < 2500) continue;
          setPendingBox({ rawId: id, x: el.x, y: el.y });
          setBoxName("");
          break;
        }
      }

      // 5. everything else the human drew/wrote is sketch — persist it
      const userEls = [...alive.values()].filter((el) => !isFlowyOwned(el) && !consumed.current.has(el.id) && el.id !== pendingBox?.rawId);
      const sig = JSON.stringify(userEls.map((e) => `${e.id}:${e.version}`));
      if (sig !== sketchSig.current) {
        sketchSig.current = sig;
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
          setChip({ x, y, target });
        }
      } else setChip(null);

      if (errors.length) onError(errors.slice(0, 2).join("\n"));
      if (mustRebuild) {
        busy.current = false;
        rebuild();
        return;
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [state.manifest, state.compileError, sources, pendingBox, rebuild, saveSketch, onError]);

  const onChange = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => void process(), 350);
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
    <div
      style={{ position: "absolute", inset: 0 }}
      onPointerDownCapture={() => (pointerDown.current = true)}
      onPointerUpCapture={() => {
        pointerDown.current = false;
        if (rebuildQueued.current) {
          rebuildQueued.current = false;
          setTimeout(rebuild, 120);
        }
      }}
    >
      <Excalidraw
        excalidrawAPI={(api: unknown) => {
          apiRef.current = api as ExAPI;
          rebuild();
        }}
        onChange={onChange}
        initialData={{ appState: { viewBackgroundColor: "#f6f4ee", currentItemFontFamily: 1, currentItemStrokeColor: INK }, scrollToContent: true }}
        UIOptions={{ canvasActions: { loadScene: false, clearCanvas: false, export: false, toggleTheme: false } }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
      {chip && (
        <button className="open-chip" style={{ left: chip.x + 8, top: chip.y - 6 }} onClick={() => onOpen(chip.target)}>
          open →
        </button>
      )}
      <div className="canvas-hint">draw a box = new step · arrow = connect · Del = remove · scribbles are yours and stay</div>
      {pendingBox && (
        <div
          className="overlay"
          onClick={() => {
            knownUser.current.add(pendingBox.rawId);
            setPendingBox(null);
          }}
        >
          <div className="paper" style={{ width: 420, marginTop: 60 }} onClick={(e) => e.stopPropagation()}>
            <div
              className="close"
              onClick={() => {
                knownUser.current.add(pendingBox.rawId);
                setPendingBox(null);
              }}
            >
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

function arrowSkeleton(
  id: string,
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  color: string,
  style: "solid" | "dashed",
  m: Manifest,
) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h;
  const bx = b.x + b.w / 2;
  const by = b.y;
  const dx = Math.abs(bx - ax) < 2 ? 2 : bx - ax;
  const dy = Math.abs(by - ay) < 2 ? 2 : by - ay;
  return {
    type: "arrow",
    id,
    x: ax,
    y: ay,
    width: dx,
    height: dy,
    strokeColor: color,
    strokeWidth: 1,
    strokeStyle: style,
    roughness: 1,
    start: { id: endpointId(id, true, m) },
    end: { id: endpointId(id, false, m) },
  };
}

function endpointId(arrowId: string, isStart: boolean, m: Manifest): string {
  const flIdFor = (id: string) => (id in m.foreach ? `fl-fe-${id}` : `fl-node-${id}`);
  if (arrowId.startsWith("fl-edge-")) {
    const [from, to] = arrowId.slice(8).split("--");
    return isStart ? flIdFor(from) : flIdFor(to);
  }
  const [idx, to] = arrowId.slice(7).split("--");
  return isStart ? `fl-src-${idx}` : flIdFor(to);
}
