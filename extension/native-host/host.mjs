// Cowork Bridge native messaging host ("daemon"). Chrome starts it via connectNative().
// - stdin/stdout: Chrome native messaging framing (uint32 little-endian length + UTF-8 JSON)
// - local clients (CLI, later the command center): Unix domain socket, newline-delimited JSON, mode 0600
// - keeps a small JSON registry of sessions seen (cache only; claude.ai is the source of truth)
// Never writes anything to stdout except framed messages. Never listens on a network port.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

// Chrome starts this process itself, so it must not depend on the workspace being resolvable: plain paths only.
const RUN_DIR = process.env.CC_RUN_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), "../../run");
const SOCK = path.join(RUN_DIR, "bridge.sock");
const REGISTRY = path.join(RUN_DIR, "registry.json");
const LOG = path.join(RUN_DIR, "host.log");
fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
const log = (...a) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
log("host start pid", process.pid, "argv", process.argv.slice(2));

// ---------- Chrome framing ----------
let inBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len).toString("utf8");
    inBuf = inBuf.subarray(4 + len);
    try { onExtension(JSON.parse(body)); } catch (e) { log("bad frame", e.message); }
  }
});
process.stdin.on("end", shutdown);
function toExtension(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// ---------- registry ----------
let registry = {};
try { registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch {}
let saveTimer = null;
function touch(sessionId, patch) {
  if (!sessionId) return;
  registry[sessionId] = { ...(registry[sessionId] || { sessionId }), ...patch, lastSeenAt: new Date().toISOString() };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2), { mode: 0o600 }), 300);
}
function learn(method, result) {
  if (!result) return;
  if (method === "session.list") for (const s of result.sessions || []) touch(s.sessionId, { kind: s.kind, title: s.title, url: s.url, group: s.group });
  const id = result.identity;
  if (id && id.sessionId) touch(id.sessionId, { title: id.title, chatId: id.chatId, kind: id.kind, ...(id.aliasOf ? { alias: id.aliasOf } : {}) });
  if (result.sessionId && result.status) touch(result.sessionId, { lastKnownStatus: result.status });
}

// ---------- clients ----------
const pending = new Map(); // hostReqId -> { sock, clientId, method, t0 }
const subscribers = new Set();
let extensionHello = null, seq = 0;

function onExtension(msg) {
  if (msg.type === "hello") { extensionHello = { ...msg, at: new Date().toISOString() }; log("extension hello", msg); toExtension({ type: "hello", from: "host", pid: process.pid }); return; }
  if (msg.type === "event") {
    if (msg.sessionId && msg.event === "session.statusChanged") touch(msg.sessionId, { lastKnownStatus: msg.status });
    if (msg.sessionId && msg.identity) touch(msg.sessionId, { title: msg.identity.title, chatId: msg.identity.chatId });
    for (const s of subscribers) send(s, msg);
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) learn(p.method, msg.result);
  send(p.sock, { ...msg, id: p.clientId, hostMs: Date.now() - p.t0 });
}
const send = (sock, obj) => { if (!sock.destroyed) sock.write(JSON.stringify(obj) + "\n"); };

function onClient(sock, req) {
  const { id, method, params } = req;
  if (method === "host.ping") return send(sock, { id, ok: true, result: { host: process.pid, extension: extensionHello, pending: pending.size } });
  if (method === "registry.list") return send(sock, { id, ok: true, result: Object.values(registry).sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || "")) });
  if (method === "events.subscribe") { subscribers.add(sock); return send(sock, { id, ok: true, result: { subscribed: true } }); }
  const hostId = `h${++seq}`;
  pending.set(hostId, { sock, clientId: id, method, t0: Date.now() });
  setTimeout(() => { if (pending.delete(hostId)) send(sock, { id, ok: false, error: { code: "TIMEOUT", message: "extension did not answer within 90s" } }); }, 90000);
  toExtension({ id: hostId, method, params: params || {} });
}

try { fs.unlinkSync(SOCK); } catch {}
const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { onClient(sock, JSON.parse(line)); } catch (e) { send(sock, { ok: false, error: { code: "BAD_REQUEST", message: e.message } }); }
    }
  });
  sock.on("close", () => subscribers.delete(sock));
  sock.on("error", () => subscribers.delete(sock));
});
server.listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); log("listening", SOCK); });

function shutdown() {
  log("stdin closed; exiting");
  try { fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2), { mode: 0o600 }); } catch {}
  try { fs.unlinkSync(SOCK); } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
