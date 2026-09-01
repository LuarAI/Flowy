import { spawn, type ChildProcess } from "node:child_process";
import fsSync, { promises as fs } from "node:fs";
import path from "node:path";

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  shell?: boolean;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Inherit the terminal instead of piping (interactive sessions). */
  inherit?: boolean;
}

export interface SpawnOutcome {
  code: number;
  timedOut: boolean;
  aborted: boolean;
  stderrTail: string;
}

const KILL_GRACE_MS = 30_000;

/**
 * Spawn a process, stream its output line by line, honour a timeout and an
 * AbortSignal. Cancellation sends SIGINT first (SPEC §7.3) and SIGKILL after
 * a grace period.
 */
export function spawnProcess(cmd: string, args: string[], opts: SpawnOptions): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let timedOut = false;
    let aborted = false;
    let settled = false;
    const stderrLines: string[] = [];

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, timedOut, aborted, stderrTail: stderrLines.slice(-40).join("\n") });
    };

    const terminate = () => {
      try {
        child.kill("SIGINT");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, KILL_GRACE_MS).unref();
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1000, opts.timeoutMs));
    timer.unref();

    child.on("error", (err) => {
      stderrLines.push(String(err.message));
      finish(-1);
    });
    child.on("close", (code) => finish(code));

    if (!opts.inherit) {
      lineReader(child.stdout!, (l) => opts.onStdoutLine?.(l));
      lineReader(child.stderr!, (l) => {
        stderrLines.push(l);
        if (stderrLines.length > 400) stderrLines.shift();
        opts.onStderrLine?.(l);
      });
      if (opts.stdin != null) {
        child.stdin!.on("error", () => {
          /* EPIPE when the child exits early */
        });
        child.stdin!.end(opts.stdin);
      } else {
        child.stdin!.end();
      }
    }
  });
}

function lineReader(stream: NodeJS.ReadableStream, onLine: (l: string) => void) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.length) onLine(line);
    }
  });
  stream.on("end", () => {
    if (buf.trim().length) onLine(buf.replace(/\r$/, ""));
    buf = "";
  });
}

/** Find an executable on PATH. On Windows, also tries .cmd/.exe/.bat. */
export async function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name] : [name];
  for (const d of dirs) {
    for (const c of candidates) {
      const p = path.join(d, c);
      try {
        const st = await fs.stat(p);
        if (st.isFile()) return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

let cachedShell: { cmd: string; args: string[] } | null = null;

/**
 * The shell used for script nodes and pre-checks (SPEC §2.2).
 * Windows: PowerShell 7 (`pwsh`) when installed — it understands `&&` — else
 * `cmd.exe`. POSIX: bash. Override with FLOWY_SHELL=<path> (PowerShell-style
 * flags are used when the name contains "pwsh" or "powershell").
 */
export function platformShell(): { cmd: string; args: string[] } {
  if (cachedShell) return cachedShell;
  const override = process.env.FLOWY_SHELL;
  if (process.platform === "win32") {
    const name = override ?? (hasOnPathSync("pwsh") ? "pwsh" : "cmd.exe");
    cachedShell = /pwsh|powershell/i.test(name) ? { cmd: name, args: ["-NoProfile", "-NonInteractive", "-Command"] } : { cmd: name, args: ["/d", "/s", "/c"] };
  } else {
    cachedShell = { cmd: override ?? "bash", args: ["-lc"] };
  }
  return cachedShell;
}

function hasOnPathSync(name: string): boolean {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const d of dirs) for (const ext of [".exe", ".cmd", ""]) {
    try {
      if (fsSync.statSync(path.join(d, name + ext)).isFile()) return true;
    } catch {
      /* next */
    }
  }
  return false;
}
