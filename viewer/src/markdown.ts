/**
 * Tiny, safe markdown renderer for chat bubbles and previews.
 * Escapes everything first, then builds known-safe HTML — no raw input ever
 * reaches innerHTML. Covers: headings, bold/italic, inline + fenced code,
 * links, unordered/ordered lists, block quotes, pipe tables, paragraphs.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, "$1<em>$2</em>");
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return t;
}

function isRow(s: string): boolean {
  // a row is any line with a pipe that is not a list item; harmless alone, it only becomes a table when a separator row follows
  return s.includes("|") && !/^\s*([-*]|\d+[.)])\s/.test(s) && !/^\s*>/.test(s);
}

/** Split a table row into trimmed cells, honoring escaped pipes inside code spans. */
function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  let inCode = false;
  for (const ch of t) {
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```/.exec(line);
    if (fence) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      // a copy button on every fenced block: prompts, scripts, descriptions get pasted elsewhere
      out.push(`<div class="codeblock"><button type="button" class="copy" data-copy title="copy this block">copy</button><pre><code>${esc(buf.join("\n"))}</code></pre></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(h[1].length + 3, 6); // h4..h6 sizes inside bubbles
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*])\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^(---|\*\*\*)\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    // pipe table: a header row, a |---|---| separator, then rows
    if (isRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      const td = (c: string, j: number, tag: "th" | "td") => `<${tag}${aligns[j] ? ` style="text-align:${aligns[j]}"` : ""}>${inline(c)}</${tag}>`;
      out.push(
        `<div class="tbl"><table><thead><tr>${head.map((c, j) => td(c, j, "th")).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_h, j) => td(r[j] ?? "", j, "td")).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join("");
}
