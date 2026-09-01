import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

export async function writeText(p: string, s: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, s, "utf8");
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readText(p)) as T;
}

export async function readJsonOrNull<T = unknown>(p: string): Promise<T | null> {
  try {
    return await readJson<T>(p);
  } catch {
    return null;
  }
}

export async function writeJson(p: string, v: unknown): Promise<void> {
  await writeText(p, JSON.stringify(v, null, 2) + "\n");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function hashFile(p: string): Promise<string> {
  const buf = await fs.readFile(p);
  return sha256(buf);
}

/** Recursively list files under a directory as relative POSIX paths, sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string) {
    const abs = path.join(dir, rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out.push(r);
    }
  }
  if (await isDir(dir)) await walk("");
  return out.sort();
}

/** Hash every file in a directory (relative path + content). */
export async function hashDir(dir: string): Promise<Record<string, string>> {
  const files = await listFiles(dir);
  const out: Record<string, string> = {};
  for (const f of files) out[f] = await hashFile(path.join(dir, f));
  return out;
}

/** Hard-link when possible, else copy. */
export async function linkOrCopy(src: string, dest: string): Promise<"link" | "copy"> {
  await ensureDir(path.dirname(dest));
  try {
    await fs.link(src, dest);
    return "link";
  } catch {
    await fs.copyFile(src, dest);
    return "copy";
  }
}

export async function copyDir(src: string, dest: string): Promise<void> {
  const files = await listFiles(src);
  for (const f of files) await linkOrCopy(path.join(src, f), path.join(dest, f));
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Parse "15m", "90s", "2h", "500ms" into milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = parseFloat(m[1]);
  switch (m[2] ?? "s") {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
  }
  return n * 1000;
}

export function nowIso(): string {
  return new Date().toISOString();
}
