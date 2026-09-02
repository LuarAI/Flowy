/**
 * Tiny, safe markdown renderer for chat bubbles and previews.
 * Escapes everything first, then builds known-safe HTML — no raw input ever
 * reaches innerHTML. Covers: headings, bold/italic, inline + fenced code,
 * links, unordered/ordered lists, paragraphs.
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
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
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
