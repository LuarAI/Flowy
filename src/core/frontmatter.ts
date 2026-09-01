import YAML from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line number of each top-level key in the file, for error messages. */
  lines: Record<string, number>;
  /** 1-based line of the body start. */
  bodyLine: number;
}

export class FrontmatterError extends Error {}

/** Parse `---\n<yaml>\n---\n<body>`. The frontmatter block must start on line 1. */
export function parseFrontmatter(text: string): Frontmatter {
  const norm = text.replace(/\r\n/g, "\n");
  if (!norm.startsWith("---\n")) throw new FrontmatterError("file must start with a `---` frontmatter block");
  const end = norm.indexOf("\n---", 4);
  if (end < 0) throw new FrontmatterError("unterminated frontmatter: missing closing `---`");
  const yamlText = norm.slice(4, end);
  const after = norm.indexOf("\n", end + 1);
  const body = after < 0 ? "" : norm.slice(after + 1).trim();
  let data: unknown;
  try {
    data = YAML.parse(yamlText) ?? {};
  } catch (e) {
    throw new FrontmatterError(`invalid YAML in frontmatter: ${(e as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new FrontmatterError("frontmatter must be a YAML mapping");
  }
  const lines: Record<string, number> = {};
  yamlText.split("\n").forEach((line, i) => {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (m && !(m[1] in lines)) lines[m[1]] = i + 2; // +1 for 1-based, +1 for the opening ---
  });
  const bodyLine = yamlText.split("\n").length + 3;
  return { data: data as Record<string, unknown>, body, lines, bodyLine };
}

/** Serialize back to a node file. Used by the viewer's graph editing (v3). */
export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlText = YAML.stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlText}\n---\n\n${body.trim()}\n`;
}
