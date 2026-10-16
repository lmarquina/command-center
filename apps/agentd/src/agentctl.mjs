#!/usr/bin/env node
// agentctl: unified CLI over agentd. Client id defaults to "cli" (override with --client).
//   agentctl ping | caps [provider] | sessions [query] [--provider p] | get <sid> [n] | status <sid> | attention | locks
//   agentctl create <provider> <cwd|-> ["title"|"first message"] [--project "Name" [--project-id uuid]]  (cowork: no cwd/project = no folder) | send <sid> "msg" | steer <sid> "msg" | interrupt <sid>
//   agentctl approve <rid> | deny <rid> | answer <rid> "label" | release <sid> | watch | shutdown      (--json, --takeover)
import net from "node:net";
import path from "node:path";
import { RUN_DIR } from "@command-center/core/paths.mjs";
const SOCK = path.join(RUN_DIR, "agentd.sock");
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (n) => argv.includes(n);
const VAL = ["--client", "--provider", "--project", "--project-id"];
const pos = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && VAL.includes(argv[i - 1])));
const [cmd, a1, a2, a3] = pos; const client = opt("--client") || "cli"; const json = flag("--json"); const takeover = flag("--takeover");
const REQ = {
  ping: () => ["ping"], caps: () => ["capabilities", { provider: a1 }], sessions: () => ["sessions", { query: a1, providers: opt("--provider") ? [opt("--provider")] : undefined }],
  get: () => ["get", { sessionId: a1, limit: Number(a2) || 10 }], status: () => ["status", { sessionId: a1 }], attention: () => ["attention"], locks: () => ["locks"],
  create: () => ["create", { provider: a1, cwd: a2 && a2 !== "-" ? path.resolve(a2) : undefined, title: ["chatgpt", "cowork"].includes(a1) ? undefined : a3, firstMessage: ["chatgpt", "cowork"].includes(a1) ? a3 : undefined, project: opt("--project"), projectId: opt("--project-id"), client, force: flag("--force") }],
  send: () => ["send", { sessionId: a1, message: a2, client, takeover, detach: flag("--detach") }], steer: () => ["steer", { sessionId: a1, message: a2, client }],
  interrupt: () => ["interrupt", { sessionId: a1, client }], approve: () => ["approve", { requestId: a1, client, takeover }], deny: () => ["deny", { requestId: a1, client, takeover }],
  answer: () => ["answer", { requestId: a1, answer: a2, client }], release: () => ["release", { sessionId: a1, client }], watch: () => ["watch"], shutdown: () => ["shutdown"],
};
if (!REQ[cmd]) { console.error("usage: agentctl ping|caps|sessions|get|status|attention|locks|create|send|steer|interrupt|approve|deny|answer|release|watch|shutdown"); process.exit(2); }
const [method, params] = REQ[cmd]();
const t0 = performance.now();
const s = net.createConnection(SOCK);
s.on("error", (e) => { console.error(`agentd not reachable at ${SOCK} (${e.code}). Start it with: npm start -w @command-center/agentd`); process.exit(3); });
s.on("connect", () => s.write(JSON.stringify({ id: "1", method, params }) + "\n"));
let buf = "", streamed = false;
s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.kind === "event") { pe(m); continue; }
  const ms = Math.round(performance.now() - t0);
  if (!m.ok) { console.error(`ERROR ${m.error.code}: ${m.error.message}`); console.error(`(${ms} ms)`); process.exit(1); }
  if (cmd === "watch") { console.error("watching… (Ctrl-C to stop)"); continue; }
  if (cmd !== "send") console.log(json ? JSON.stringify(m.result, null, 2) : human(cmd, m.result));
  console.error(`(${ms} ms client; daemon ${m.ms} ms)`); process.exit(0); } });
function pe(e) {
  if (json) return console.log(JSON.stringify(e));
  const ts = (e.at || "").slice(11, 23), sid = `${e.provider}`;
  if (e.type === "agent.output.delta") { if (e.provider === "claude-code" || e.provider === "codex") { process.stdout.write(e.text); streamed = true; } return; }
  if (e.type === "agent.output.complete") { if (streamed) { process.stdout.write("\n"); streamed = false; return; } if (!e.final && (e.provider === "chatgpt" || e.provider === "cowork")) return; return console.log(`${ts} ${sid} assistant: ${(e.text || "").slice(0, 300)}`); }
  const extra = e.status ? e.status : e.tool ? `${e.tool} ${JSON.stringify(e.details || {}).slice(0, 120)}` : e.request ? `${e.request.requestId} ${e.request.description}${e.request.question ? " [" + e.request.question.map((q) => q.options.join(" | ")).join("; ") + "]" : ""}` : e.result ? e.result.slice(0, 200) : e.requestId || e.message || "";
  console.log(`${ts} ${sid} [${e.type}] ${extra}`);
}
function human(c, r) {
  if (c === "sessions") return r.sessions.map((x) => `${x.sessionId.padEnd(52)} ${(x.status || "").padEnd(17)} ${String(x.title || "").slice(0, 50)}`).join("\n") + `\n${r.sessions.length} sessions${Object.keys(r.degraded).length ? `  DEGRADED: ${JSON.stringify(r.degraded)}` : ""}`;
  if (c === "attention") return r.length ? r.map((a) => `${a.kind.padEnd(9)} ${a.provider.padEnd(11)} ${a.sessionId}  ${a.requestId ? a.requestId + "  " : ""}${String(a.text || "").slice(0, 80)}`).join("\n") : "nothing needs you";
  if (c === "get") return `${r.sessionId}  "${r.title}"  status=${r.status}  (${r.messages.length} of ${r.totalMessages})\n` + r.messages.map((m) => `  ${m.role.padEnd(9)} ${String(m.text || (m.tool && m.tool.name) || "").replace(/\s+/g, " ").slice(0, 140)}`).join("\n");
  return JSON.stringify(r, null, 2);
}
