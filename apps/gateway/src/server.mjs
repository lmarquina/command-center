#!/usr/bin/env node
// Command Center gateway: the local web UI and API on http://127.0.0.1:<port> → agentd. No provider logic here.
// Security (it can drive agents on this Mac):
//   - binds 127.0.0.1 only; rejects requests whose Host isn't localhost/127.0.0.1:<port> (DNS-rebinding guard)
//   - every /api call needs header X-CC-Token = run/token (custom header ⇒ cross-site pages can't send it without CORS,
//     and we never send CORS headers); the token is injected only into our own same-origin page
//   - the SSE stream needs ?token= (EventSource can't set headers); same token
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AgentdClient } from "./agentdClient.mjs";
import { buildHome, foldLive } from "./viewModel.mjs";
import { startGlassesGateway } from "./glassesGateway.mjs";
import { loadTls, glassesOrigins } from "./network.mjs";
import { appender } from "@command-center/core/appender.mjs";
import { loadConfig } from "@command-center/core/config.mjs";
import { runPath, RUN_DIR } from "@command-center/core/paths.mjs";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const CONFIG = loadConfig(), CFG = CONFIG.gateway;
const PORT = Number(process.env.CC_PORT || CFG.port);
const TOKEN_FILE = runPath("token");
if (!fs.existsSync(TOKEN_FILE)) fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
const CLIENT = "web-ui";

const agentd = new AgentdClient();
const live = {}; const sse = new Set();
agentd.on("event", (ev) => { foldLive(live, ev); const line = `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`; for (const r of sse) r.write(line); });
agentd.on("status", (s) => { for (const r of sse) r.write(`event: agentd\ndata: ${JSON.stringify(s)}\n\n`); });
agentd.watch();

export function hostAllowed(host, port = PORT) { return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(host || "").toLowerCase()); }
export function tokenOk(given) { const a = Buffer.from(String(given || "")), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); }

const body = (req) => new Promise((res, rej) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > 1e6) req.destroy(); }); req.on("end", () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(Object.assign(new Error("bad JSON"), { code: "BAD_REQUEST" })); } }); });
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(obj)); };
const ERR_HTTP = { BAD_SESSION_ID: 400, BAD_REQUEST_ID: 400, BAD_REQUEST: 400, SESSION_LOCKED: 409, WRITER_BUSY: 409, NOT_SUPPORTED: 422, NO_SUCH_REQUEST: 404, NOT_FOUND: 404, AGENTD_DOWN: 503, BRIDGE_DOWN: 503, PROVIDER_UNAVAILABLE: 503 };

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const seg = p.split("/").map(decodeURIComponent); // ["", "api", ...]
  const call = (method, params) => agentd.request(method, params);
  if (m === "GET" && p === "/api/home") {
    const [list, attention] = await Promise.all([call("sessions", {}), call("attention", {})]);
    return json(res, 200, { ...buildHome({ sessions: list.sessions, attention, live }), degraded: list.degraded, agentdConnected: agentd.connected });
  }
  if (m === "GET" && p === "/api/sessions") return json(res, 200, await call("sessions", { query: url.searchParams.get("q") || undefined, providers: url.searchParams.get("provider") ? [url.searchParams.get("provider")] : undefined }));
  if (m === "GET" && p === "/api/health") return json(res, 200, await call("health"));
  if (m === "GET" && p === "/api/attention") return json(res, 200, await call("attention"));
  if (m === "GET" && p === "/api/capabilities") return json(res, 200, await call("capabilities", {}));
  if (seg[2] === "sessions" && seg[3]) {
    const sessionId = seg[3];
    if (m === "GET" && !seg[4]) { const d = await call("get", { sessionId, limit: Number(url.searchParams.get("limit")) || 30 }); return json(res, 200, { ...d, live: live[sessionId] || null }); }
    if (m === "POST") {
      const b = await body(req);
      switch (seg[4]) {
        case "send": return json(res, 202, await call("send", { sessionId, message: String(b.message || ""), client: CLIENT, takeover: !!b.takeover, detach: true }));
        case "steer": return json(res, 202, await call("steer", { sessionId, message: String(b.message || ""), client: CLIENT }));
        case "interrupt": return json(res, 200, await call("interrupt", { sessionId, client: CLIENT }));
        case "ack": return json(res, 200, (await call("ack", { sessionId })) || { ok: true });
        case "release": return json(res, 200, (await call("release", { sessionId, client: CLIENT })) || { ok: true });
      }
    }
  }
  // Test hooks for the glasses: force walking mode / start a reading, or speak a line.
  if (m === "POST" && p === "/api/glasses/walk") { const { on, read, who } = await body(req); return json(res, 200, { glasses: glasses ? (read ? glasses.read(who || "chatgpt", String(read)) : glasses.walkMode(on === "auto" ? null : !!on)) : 0 }); }
  if (m === "POST" && p === "/api/glasses/voice") { const { text } = await body(req); return json(res, 200, { glasses: glasses ? glasses.hear(String(text || "").slice(0, 500)) : 0 }); }
  if (m === "POST" && p === "/api/glasses/say") { const { text, voice, method } = await body(req); return json(res, 200, { glasses: glasses ? glasses.speakAll(String(text || "").slice(0, 300), voice || "system", method) : 0 }); }
  if (m === "POST" && p === "/api/sessions") {
    const { provider, firstMessage, title, project, projectId, cwd } = await body(req); // explicit allowlist of create fields
    return json(res, 201, await call("create", { provider, firstMessage, title, project, projectId, cwd, client: CLIENT }));
  }
  if (m === "POST" && seg[2] === "requests" && seg[3] && ["approve", "deny", "answer"].includes(seg[4])) {
    const b = await body(req);
    return json(res, 200, await call(seg[4], { requestId: seg[3], answer: b.answer, client: CLIENT, takeover: !!b.takeover }));
  }
  return json(res, 404, { error: { code: "NOT_FOUND", message: `${m} ${p}` } });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
let glasses = null;
export const server = http.createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host)) { res.writeHead(421); return res.end("bad host"); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/events") {
      if (!tokenOk(url.searchParams.get("token"))) return json(res, 401, { error: { code: "UNAUTHORIZED" } });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`event: agentd\ndata: ${JSON.stringify({ connected: agentd.connected })}\n\n`);
      sse.add(res); const ka = setInterval(() => res.write(": ka\n\n"), 25000);
      req.on("close", () => { sse.delete(res); clearInterval(ka); });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!tokenOk(req.headers["x-cc-token"])) return json(res, 401, { error: { code: "UNAUTHORIZED", message: "missing/invalid X-CC-Token" } });
      return await api(req, res, url);
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[a-z0-9_.-]+$/i.test(file)) { res.writeHead(404); return res.end(); }
    const fp = path.join(ROOT, "public", file);
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end(); }
    let content = fs.readFileSync(fp, "utf8");
    if (file === "index.html") content = content.replace("__CC_TOKEN__", TOKEN);
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "text/plain", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
    res.end(content);
  } catch (e) {
    json(res, ERR_HTTP[e.code] || 500, { error: { code: e.code || "ERROR", message: e.message, holder: e.holder } });
  }
});
if (process.argv[1] && process.argv[1].endsWith("server.mjs")) {
  // A bug in one handler must not take the whole gateway down: log it and keep serving.
  process.on("unhandledRejection", (e) => console.error(new Date().toISOString(), "unhandled rejection:", e && e.stack || e));
  server.listen(PORT, "127.0.0.1", () => console.error(`Command Center on http://127.0.0.1:${PORT} (agentd: ${agentd.sock})`));
  if (CFG.glasses && process.env.CC_GLASSES !== "0") {
    const g = CFG.glasses, tls = loadTls(), origins = glassesOrigins(g, tls), logFile = runPath("glasses.log");
    const writeLog = appender(logFile);
    const log = (...a) => writeLog(`${new Date().toISOString()} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}\n`);
    // Without a certificate the token would cross the network in clear text: listen on this computer only, unless
    // plain Wi-Fi was explicitly allowed (gateway.glasses.allowPlainLan).
    const host = tls || g.allowPlainLan ? "0.0.0.0" : "127.0.0.1";
    glasses = startGlassesGateway({ agentd, live, token: TOKEN, port: g.port, host, allowedOrigins: origins, log, tls, runDir: RUN_DIR, voiceUrl: CONFIG.voice.url, tuning: g.tuning });
    console.error(`Glasses gateway ${tls ? `wss://${tls.host}` : `ws://${host}`}:${g.port}  origins=${origins.join(",")}`);
  }
}
