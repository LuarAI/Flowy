import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { addrParams, get, post, type NodeAddr, type TraceEvent } from "./client";
import { renderMarkdown } from "./markdown";
import { Play } from "./icons";

/*
 * One conversation, wherever it is shown: a chat card on the canvas or a
 * line's pane on the map. Every message is one engine turn in that node's
 * isolated directory; the transcript is the node's trace.jsonl.
 */

export interface ChatMsg {
  role: "user" | "assistant" | "tool" | "note" | "station";
  text: string;
  /** station markers: the full prompt that opened it (shown on hover) */
  detail?: string;
}

export function traceToMessages(trace: TraceEvent[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const e of trace) {
    const p = e.payload as Record<string, unknown> | string | null;
    if (e.type === "user" && p && typeof p === "object" && typeof p.text === "string") {
      const st = p.station as { index: number; total: number; title: string; gate: string } | undefined;
      if (st) out.push({ role: "station", text: `station ${st.index + 1} of ${st.total} — ${st.title}${st.gate === "you" ? " · yours" : ""}`, detail: p.text });
      else out.push({ role: "user", text: p.text });
    } else if (e.type === "text" && p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string") out.push({ role: "assistant", text: String((p as Record<string, unknown>).text) });
    else if (e.type === "tool_use" && p && typeof p === "object" && typeof (p as Record<string, unknown>).name === "string") {
      // say WHAT it touched, not just the tool name
      const input = ((p as Record<string, unknown>).input ?? {}) as Record<string, unknown>;
      let detail = "";
      if (typeof input.command === "string") detail = input.command.slice(0, 64);
      else if (typeof input.description === "string") detail = input.description.slice(0, 64);
      else {
        const pth = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query;
        if (typeof pth === "string") detail = pth.replace(/\\/g, "/").split("/").pop()!.slice(0, 64);
      }
      out.push({ role: "tool", text: `${String((p as Record<string, unknown>).name)}${detail ? ` · ${detail}` : ""}` });
    } else if (e.type === "end" && p && typeof p === "object" && (p as Record<string, unknown>).stopped === true) {
      out.push({ role: "tool", text: "■ stopped — this conversation continues where it left off" });
    } else if (e.type === "end" && p && typeof p === "object" && (p as Record<string, unknown>).timed_out === true) {
      out.push({ role: "tool", text: "⏱ hit this chat's turn time limit — send a message to continue" });
    }
  }
  // merge consecutive identical tool lines
  return out.filter((m, i) => !(m.role === "tool" && out[i - 1]?.role === "tool" && out[i - 1].text === m.text));
}

export interface ChatViewProps {
  dir: string;
  runId: string | undefined;
  addr: NodeAddr;
  /** Bump to refetch the transcript. */
  refreshKey: number;
  model: string;
  permissions: string;
  onError: (msg: string) => void;
  /** A turn is running that this view did not start (a line station): show it, queue what's typed. */
  externalBusy?: boolean;
  placeholder?: string;
  emptyHint?: string;
  /** Extra rows rendered inside the scroll area, after the messages (e.g. gate chips). */
  tail?: ReactNode;
  /** Chat cards on the canvas are React Flow nodes: mark inner areas nodrag/nowheel. */
  inFlow?: boolean;
  onTurn?: () => void;
  style?: React.CSSProperties;
}

export function ChatView(p: ChatViewProps) {
  const { addr, runId, refreshKey } = p;
  const key = addr.item ? `${addr.item.foreach}/${addr.item.id}:${addr.node}` : addr.node;
  const draftKey = `flowy-draft:${p.dir}:${key}`;
  const [msgs, setMsgs] = useState<ChatMsg[] | null>(null);
  const [draft, setDraftRaw] = useState<string>(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const setDraft = (v: string) => {
    setDraftRaw(v);
    try {
      if (v) localStorage.setItem(draftKey, v);
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage unavailable */
    }
  };
  const [busy, setBusy] = useState(false);
  // Messages typed while a turn is running: sent, in order, the moment it ends.
  const [queue, setQueue] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const [perms, setPerms] = useState<Array<{ id: string; tool: string; detail: string }>>([]);
  const scroller = useRef<HTMLDivElement>(null);
  // Stick to the bottom only while the reader is there; scrolling up to read stays put.
  const stuck = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const anyBusy = busy || !!p.externalBusy;

  useEffect(() => {
    let live = true;
    get<{ trace: TraceEvent[] }>("/api/node", { run: runId, ...addrParams(addr) })
      .then((d) => live && setMsgs(traceToMessages(d.trace)))
      .catch(() => live && setMsgs([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runId, refreshKey]);

  useEffect(() => {
    const onEvent = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { addr: NodeAddr; event: TraceEvent };
      const dk = d.addr.item ? `${d.addr.item.foreach}/${d.addr.item.id}:${d.addr.node}` : d.addr.node;
      if (dk !== key) return;
      const add = traceToMessages([d.event]);
      if (!add.length) return;
      setMsgs((cur) => [...(cur ?? []), ...add]);
      if (!stuck.current) setUnseen((n) => n + add.filter((m) => m.role !== "tool").length);
    };
    window.addEventListener("flowy:chat-event", onEvent);
    return () => window.removeEventListener("flowy:chat-event", onEvent);
  }, [key]);

  useEffect(() => {
    if (stuck.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [msgs, perms, queue]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stuck.current = atBottom;
    if (atBottom) setUnseen(0);
  };
  const jumpDown = () => {
    stuck.current = true;
    setUnseen(0);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };

  // permission requests: this chat wants to use a tool outside its allowlist
  useEffect(() => {
    const onPerm = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { id: string; addr: NodeAddr; tool: string; input: Record<string, unknown> };
      const dk = d.addr.item ? `${d.addr.item.foreach}/${d.addr.item.id}:${d.addr.node}` : d.addr.node;
      if (dk !== key) return;
      const input = d.input ?? {};
      const detail = String(input.query ?? input.command ?? input.url ?? input.prompt ?? input.file_path ?? input.path ?? "").slice(0, 120);
      setPerms((cur) => [...cur, { id: d.id, tool: d.tool, detail }]);
    };
    const onDone = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { id: string };
      setPerms((cur) => cur.filter((x) => x.id !== d.id));
    };
    window.addEventListener("flowy:perm", onPerm);
    window.addEventListener("flowy:perm-done", onDone);
    return () => {
      window.removeEventListener("flowy:perm", onPerm);
      window.removeEventListener("flowy:perm-done", onDone);
    };
  }, [key]);

  const postTurn = useCallback(
    (text: string) =>
      post<{ stopped?: boolean }>("/api/chat-message", {
        run: runId,
        node: addr.node,
        item: addr.item ? `${addr.item.foreach}/${addr.item.id}` : undefined,
        text,
        model: p.model || undefined,
        permissions: p.permissions !== "ask" ? p.permissions : undefined,
      }),
    [runId, addr, p.model, p.permissions],
  );

  const flush = useCallback(
    async (first?: string) => {
      setBusy(true);
      let current = first ?? queueRef.current.shift();
      setQueue([...queueRef.current]);
      if (current === undefined) {
        setBusy(false);
        return;
      }
      try {
        for (;;) {
          await postTurn(current);
          p.onTurn?.();
          const next = queueRef.current.shift();
          setQueue([...queueRef.current]);
          if (next === undefined) break;
          current = next;
        }
      } catch (e) {
        // Everything unsent comes back to the box: the failed message plus the queue.
        const back = [current, ...queueRef.current].join("\n");
        queueRef.current = [];
        setQueue([]);
        setDraftRaw((cur) => {
          const keep = cur.trim() ? cur : back;
          try {
            localStorage.setItem(draftKey, keep);
          } catch {
            /* storage unavailable */
          }
          return keep;
        });
        p.onError(`your message is back in the box — ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [postTurn, draftKey],
  );

  // A station turn ended: whatever was typed meanwhile goes out now.
  useEffect(() => {
    if (!p.externalBusy && !busy && queueRef.current.length) void flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.externalBusy]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (anyBusy) {
      queueRef.current = [...queueRef.current, text];
      setQueue(queueRef.current);
      return;
    }
    stuck.current = true;
    await flush(text);
  };

  const stopTurn = () =>
    void post("/api/chat-stop", { run: runId, node: addr.node, item: addr.item ? `${addr.item.foreach}/${addr.item.id}` : undefined }).catch(() => {});

  const flowCls = p.inFlow ? " nowheel nodrag" : "";
  return (
    <div className="chatview" style={p.style}>
      <div className="bubbles-wrap">
        <div ref={scroller} onScroll={onScroll} className={`bubbles${flowCls}`}>
          {msgs === null && <div className="muted small">…</div>}
          {msgs !== null && msgs.length === 0 && <div className="muted small">{p.emptyHint ?? "say something to start"}</div>}
          {(msgs ?? []).map((m, i) =>
            m.role === "tool" ? (
              <div key={i} className="tool-line">
                ⚙ {m.text}
              </div>
            ) : m.role === "station" ? (
              <div key={i} className="station-line" title={m.detail}>
                <span>● {m.text}</span>
              </div>
            ) : m.role === "assistant" ? (
              <div key={i} className="bubble assistant md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
            ) : (
              <div key={i} className={`bubble ${m.role}`}>
                {m.text}
              </div>
            ),
          )}
          {queue.map((t, i) => (
            <div key={`q${i}`} className="bubble user queued" title="queued — sends when this turn ends">
              {t}
            </div>
          ))}
          {perms.map((pm) => (
            <div key={pm.id} className="perm-ask">
              <div className="perm-text">
                wants to use <strong>{pm.tool.replace(/^mcp__[^_]+__/, "")}</strong>
                {pm.detail ? ` — ${pm.detail}` : ""}
              </div>
              <div className="perm-buttons">
                <button className="primary" onClick={() => void post("/api/perm/answer", { id: pm.id, behavior: "allow" })}>
                  allow
                </button>
                <button className="ghost" onClick={() => void post("/api/perm/answer", { id: pm.id, behavior: "deny" })}>
                  deny
                </button>
              </div>
            </div>
          ))}
          {anyBusy && perms.length === 0 && <div className="tool-line">thinking…</div>}
          {p.tail}
        </div>
        {unseen > 0 && (
          <button className="new-below" onClick={jumpDown}>
            ↓ {unseen} new
          </button>
        )}
      </div>
      <div className={`chat-input${flowCls}`}>
        <textarea
          rows={1}
          placeholder={anyBusy ? "queue a message — sends when this turn ends" : (p.placeholder ?? "talk to it")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {anyBusy ? (
          <button className="ghost stop" onClick={stopTurn} title="stop this turn — everything done so far is kept">
            ■
          </button>
        ) : (
          <button className="ghost" disabled={!draft.trim()} onClick={() => void send()} title="send (Enter)">
            <Play size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
