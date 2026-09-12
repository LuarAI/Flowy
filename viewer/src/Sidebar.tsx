import { useEffect, useState } from "react";

/*
 * Workspace switcher. One address serves every workflow (the hub proxies
 * /w/<slug>/ to that workflow's own server), so this is the thing that makes
 * many workflows feel like one app instead of a list of ports to remember.
 *
 * Conventions taken from current sidebar practice: ~260px open and a 52px icon
 * rail collapsed, the choice remembered across sessions, a 200ms transition, and
 * tooltips carrying the label when only the icon shows.
 */

export interface Space {
  slug: string;
  name: string;
  dir: string;
  running: boolean;
  error: string | null;
}

const KEY = "flowy-sidebar-open";

/** The slug this page is serving, from /w/<slug>/… — empty when served directly. */
export function currentSlug(): string {
  const m = /^\/w\/([^/]+)/.exec(location.pathname);
  return m ? m[1] : "";
}

export function Sidebar({ needs }: { needs?: number }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [dir, setDir] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const slug = currentSlug();

  useEffect(() => {
    fetch("/api/hub/workspaces")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setSpaces(j?.workspaces ?? []))
      .catch(() => setSpaces([]));
  }, []);

  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(KEY, v ? "0" : "1");
      } catch {
        /* storage unavailable */
      }
      return !v;
    });
  };

  const add = async () => {
    setErr(null);
    try {
      const r = await fetch("/api/hub/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "could not add it");
      location.href = `/w/${j.slug}/`;
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // Served without the hub: no switcher to show.
  if (spaces !== null && spaces.length === 0 && !slug) return null;

  return (
    <nav className={`sidebar${open ? "" : " collapsed"}`} aria-label="workflows">
      <div className="side-head">
        {open && <span className="side-title">workflows</span>}
        <button className="ghost side-toggle" onClick={toggle} title={open ? "collapse (keeps your choice)" : "expand"} aria-expanded={open}>
          {open ? "«" : "»"}
        </button>
      </div>

      <div className="side-list">
        {spaces === null && <div className="muted small side-empty">…</div>}
        {(spaces ?? []).map((s) => {
          const here = s.slug === slug;
          return (
            <a
              key={s.slug}
              href={`/w/${s.slug}/`}
              className={`side-item${here ? " on" : ""}`}
              title={open ? s.dir : `${s.name} — ${s.dir}`}
              aria-current={here ? "page" : undefined}
            >
              <span className="side-dot" aria-hidden>
                {s.name.slice(0, 1).toUpperCase()}
              </span>
              {open && (
                <span className="side-label">
                  {s.name}
                  {here && needs ? <span className="side-badge">{needs}</span> : null}
                </span>
              )}
            </a>
          );
        })}
      </div>

      <div className="side-foot">
        {open ? (
          adding ? (
            <div className="side-add">
              <input
                autoFocus
                placeholder="path to a workflow folder"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                  if (e.key === "Escape") setAdding(false);
                }}
              />
              {err && <div className="side-err">{err}</div>}
              <div className="side-add-row">
                <button className="primary small" onClick={() => void add()} disabled={!dir.trim()}>
                  add
                </button>
                <button className="ghost small" onClick={() => setAdding(false)}>
                  cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="ghost small side-addbtn" onClick={() => setAdding(true)}>
              + workflow
            </button>
          )
        ) : (
          <button className="ghost side-addbtn" onClick={toggle} title="add a workflow">
            +
          </button>
        )}
      </div>
    </nav>
  );
}
