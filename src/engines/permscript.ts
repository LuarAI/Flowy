/**
 * The permission-prompt MCP server, as source text. Written to a temp file at
 * runtime and handed to `claude -p` via --mcp-config +
 * --permission-prompt-tool, so that permission requests (WebSearch, extra
 * Bash, anything outside the node's allowlist) surface as approve/deny
 * bubbles in the chat card instead of being silently denied.
 *
 * Protocol: newline-delimited JSON-RPC over stdio (MCP). One tool,
 * `approve`, which forwards the request to the local Flowy server and blocks
 * until the human answers in the browser.
 */
export const PERM_SCRIPT_SOURCE = `#!/usr/bin/env node
"use strict";
const URL_BASE = process.env.FLOWY_PERM_URL;
const TOKEN = process.env.FLOWY_PERM_TOKEN;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}
async function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: (params && params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "flowy-perm", version: "1.0.0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{ name: "approve", description: "Ask the human in the Flowy chat card whether a tool call is allowed.", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] } }] } });
  } else if (method === "tools/call") {
    const args = (params && params.arguments) || {};
    let behavior = "deny";
    let message = "no answer from the human";
    try {
      const res = await fetch(URL_BASE + "/api/perm/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: TOKEN, tool: args.tool_name, input: args.input }),
      });
      const j = await res.json();
      if (j.behavior === "allow") behavior = "allow";
      else message = j.message || "denied in the chat";
    } catch (e) {
      message = String((e && e.message) || e);
    }
    const payload = behavior === "allow" ? { behavior: "allow", updatedInput: args.input } : { behavior: "deny", message };
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
}
`;
