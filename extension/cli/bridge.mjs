#!/usr/bin/env node
// Tiny test CLI for the Cowork Bridge daemon (Unix socket). Deterministic: no LLM anywhere.
//   cowork doctor | ping | sessions | registry
//   cowork open|read|status|approve|deny|stop <sessionId>
//   cowork send <sessionId> "message" [--force]
//   cowork answer <sessionId> "option label"
//   cowork watch                      (stream events)
//   cowork snapshot <sessionId|-> <fixture-name>   (dev: write sanitized DOM fixture)
//   add --json for raw output
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUN_DIR = process.env.CC_RUN_DIR || path.join(HERE, "../../run");
const SOCK = path.join(RUN_DIR, "bridge.sock");
const FIXTURES = path.join(HERE, "../fixtures");
const argv = process.argv.slice(2);
const json = argv.includes("--json"), force = argv.includes("--force");
const provIdx = argv.indexOf("--provider"); const provider = provIdx >= 0 ? argv[provIdx + 1] : undefined;
const [cmd, ...args] = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--provider"));

const MAP = {
  ping: () => ["host.ping"], "reload-extension": () => ["bridge.reload"], xping: () => ["bridge.ping"], tabs: () => ["bridge.tabs"], doctor: () => ["bridge.doctor"], sessions: () => ["session.list"], registry: () => ["registry.list"],
  open: (id) => ["session.open", { sessionId: id }], read: (id, n) => ["session.read", { sessionId: id, limit: Number(n) || 10 }],
  status: (id) => ["session.status", { sessionId: id }], approve: (id) => ["session.approve", { sessionId: id }],
  deny: (id) => ["session.deny", { sessionId: id }], stop: (id) => ["session.stop", { sessionId: id }],
  send: (id, message) => ["session.send", { sessionId: id, message, force }], answer: (id, option) => ["session.answer", { sessionId: id, option }],
  snapshot: (id) => ["debug.snapshot", id && id !== "-" ? { sessionId: id } : {}],
  watch: () => ["events.subscribe"],
  health: () => ["bridge.health"], inventory: () => ["session.inventory"],
  new: (message) => ["session.new", { message, force }],
};
if (!MAP[cmd]) { console.error("usage: bridge health|inventory|doctor|ping|sessions|registry|open|read|status|send|answer|approve|deny|stop|watch|snapshot …"); process.exit(2); }
const [method, params0] = MAP[cmd](...args);
const params = provider ? { ...(params0 || {}), provider } : params0;

const sock = net.createConnection(SOCK);
const t0 = performance.now();
sock.on("error", (e) => { console.error(`bridge not reachable at ${SOCK} (${e.code}). Is Chrome running with the Cowork Bridge extension loaded?`); process.exit(3); });
sock.on("connect", () => sock.write(JSON.stringify({ id: "c1", method, params }) + "\n"));
let buf = "";
sock.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.type === "event") { console.log(json ? JSON.stringify(msg) : fmtEvent(msg)); continue; }
    const ms = Math.round(performance.now() - t0);
    if (cmd === "watch" && msg.ok) { console.error("watching events… (Ctrl-C to stop)"); continue; }
    if (!msg.ok) { console.error(`ERROR ${msg.error.code}: ${msg.error.message}${msg.error.details ? "\n" + JSON.stringify(msg.error.details, null, 2) : ""}`); console.error(`(${ms} ms)`); process.exit(1); }
    if (cmd === "snapshot") {
      const name = args[1] || "snapshot";
      fs.writeFileSync(path.join(FIXTURES, `${name}.html`), `<!-- sanitized claude.ai <main>; captured ${new Date().toISOString()}; status=${msg.result.snapshot.status} -->\n${msg.result.html}\n`);
      console.log(`wrote fixtures/${name}.html (status=${msg.result.snapshot.status}, ${msg.result.html.length} bytes)`);
    } else console.log(json ? JSON.stringify(msg.result, null, 2) : human(cmd, msg.result));
    console.error(`(${ms} ms round trip)`);
    process.exit(0);
  }
});

function fmtEvent(e) {
  const extra = e.status ? ` ${e.from || "?"} → ${e.status}` : e.role ? ` [${e.role} #${e.index}] ${String(e.text || "").replace(/\s+/g, " ").slice(0, 100)}` : e.textLength ? ` #${e.index} len=${e.textLength}` : "";
  return `${e.at} ${e.event} ${e.sessionId || ""}${extra}${e.question ? ` Q: ${e.question.text} [${e.question.options.join(" | ")}]` : ""}${e.approval ? ` APPROVAL: ${e.approval.detail.slice(0, 120)}` : ""}`;
}
function human(cmd, r) {
  switch (cmd) {
    case "doctor": {
      const lines = ["Cowork Web Bridge", "-----------------", `native messaging      ${r.nativeMessaging}`, `claude tab            ${r.claudeTab}`];
      for (const [k, v] of Object.entries(r.checks || {})) lines.push(`${k.padEnd(21)} ${v}`);
      if (r.mode) lines.push(`mode                  ${r.mode}`);
      if (r.identity) lines.push(`open session          ${r.identity.sessionId || "-"}  "${r.identity.title}"`);
      return lines.join("\n");
    }
    case "sessions": return `${r.sessions.length} sessions (${r.source})\n` + r.sessions.map((s) => `${s.current ? "*" : " "} ${s.sessionId.padEnd(42)} ${s.kind.padEnd(6)} ${(s.group || "").padEnd(10)} ${s.title}`).join("\n");
    case "read": return `${r.sessionId}  (${r.rendered} rendered of ${r.total})\n` + r.messages.map((m) => `#${m.index} ${m.role}${m.streaming ? " (streaming)" : ""}${m.interrupted ? " (interrupted)" : ""}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}${m.tools && m.tools.length ? `\n     tools: ${m.tools.join(" | ")}` : ""}`).join("\n");
    case "status": return `${r.sessionId}  ${r.status}${r.environment ? `  [${r.environment}]` : ""}${r.question ? `\n  question: ${r.question.text}\n  options: ${r.question.options.join(" | ")}` : ""}${r.approval ? `\n  approval: ${r.approval.detail}` : ""}`;
    default: return JSON.stringify(r, null, 2);
  }
}
