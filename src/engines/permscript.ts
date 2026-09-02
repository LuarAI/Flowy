/**
 * The permission bridge, as source text — a Claude Code PreToolUse HOOK
 * (verified working on CLI 2.1.63; the --permission-prompt-tool MCP route is
 * broken there: it validates before --mcp-config servers connect).
 *
 * Wiring (claude.ts): --settings <file> with matcher "*" so this fires for
 * every tool call, --permission-mode default. Tools in FLOWY_AUTOALLOW are
 * allowed instantly; everything else asks the human in the chat card via the
 * Flowy server and blocks until answered.
 *
 * Hard-won rules encoded here:
 *  - answer on the FIRST complete JSON and exit(0); never wait for stdin
 *    close (deadlocks the CLI)
 *  - output shape: hookSpecificOutput.permissionDecision allow|deny
 */
export const PERM_SCRIPT_SOURCE = `#!/usr/bin/env node
"use strict";
const URL_BASE = process.env.FLOWY_PERM_URL;
const TOKEN = process.env.FLOWY_PERM_TOKEN;
const AUTO = new Set((process.env.FLOWY_AUTOALLOW || "").split(",").map((s) => s.trim()).filter(Boolean));
function answer(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason || "" } }));
  process.exit(0);
}
setTimeout(() => answer("deny", "no answer from the human (timed out)"), 11 * 60_000);
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  s += d;
  let req;
  try { req = JSON.parse(s); } catch { return; } // keep buffering until the JSON is complete
  void decide(req);
});
async function decide(req) {
  const tool = String(req.tool_name || "");
  if (AUTO.has("*")) return answer("allow", "this chat allows everything");
  if (AUTO.has(tool)) return answer("allow", "in this chat's allowlist");
  if (!URL_BASE || !TOKEN) return answer("deny", "no permission channel");
  try {
    const res = await fetch(URL_BASE + "/api/perm/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, tool, input: req.tool_input || {} }),
    });
    const j = await res.json();
    if (j.behavior === "allow") return answer("allow", "allowed in the chat");
    return answer("deny", j.message || "denied in the chat");
  } catch (e) {
    return answer("deny", "permission channel failed: " + String((e && e.message) || e));
  }
}
`;
