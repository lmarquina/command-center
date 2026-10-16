import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { startGlassesGateway } from "../src/glassesGateway.mjs";
import { EventEmitter } from "node:events";
import { glassesOrigins } from "../src/network.mjs";

const TOKEN = "t".repeat(48), ORIGIN = "http://localhost:5173";
const sessions = [
  { sessionId: "codex:a", provider: "codex", title: "Research repo", status: "idle", updatedAt: "2026-10-01" },
  { sessionId: "cowork:cse_X", provider: "cowork", title: "Weekly Newsletter", status: "approval_required", updatedAt: "2026-10-03" },
];
const attention = [{ kind: "approval", sessionId: "cowork:cse_X", provider: "cowork", requestId: "cowork:cse_X#approval", text: "Use folder" }];
function fakeAgentd() { const calls = []; return Object.assign(new EventEmitter(), { calls, request: async (method, params) => { calls.push([method, params]); return method === "sessions" ? { sessions, degraded: {} } : method === "attention" ? attention : method === "health" ? [{ id: "codex", ok: true, label: "Codex: connected" }] : { ok: true }; } }); }
function start(extra = {}) {
  const port = 4100 + Math.floor(Math.random() * 800), agentd = fakeAgentd();
  const gw = startGlassesGateway({ agentd, live: {}, token: TOKEN, port, host: "127.0.0.1", allowedOrigins: [ORIGIN], speakEvents: false, runDir: fs.mkdtempSync(path.join(os.tmpdir(), "cc-gg-")), ...extra });
  return { port, agentd, gw, stop: () => new Promise((r) => { for (const w of [gw.wss, gw.localWss]) for (const c of w.clients) c.terminate(); gw.localWss.close(() => gw.wss.close(r)); }) };
}
function connect(port, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin }), msgs = [], waiters = [];
  ws.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d)); for (const w of waiters.splice(0)) w(); });
  const until = async (pred) => { for (let i = 0; i < 200; i++) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => { waiters.push(r); setTimeout(r, 25); }); } throw new Error("timed out: " + JSON.stringify(msgs).slice(0, 300)); };
  const closed = new Promise((r) => { ws.on("close", (code) => r(code)); ws.on("error", () => {}); ws.on("unexpected-response", (_q, res) => r(res.statusCode)); });
  return { ws, msgs, until, closed, open: new Promise((r) => ws.on("open", r)) };
}
const text = (page) => JSON.stringify(page);

test("a page from an origin that is not allowed cannot connect; a wrong token is disconnected", async () => {
  const s = start();
  assert.equal(await connect(s.port, "https://evil.example").closed, 403);
  const c = connect(s.port); await c.open; c.ws.send(JSON.stringify({ type: "hello", token: "x".repeat(48) }));
  assert.equal(await c.closed, 4003);
  assert.deepEqual(s.agentd.calls, [], "nothing was read for an unauthenticated client");
  await s.stop();
});

test("after hello the glasses get the home screen built from the daemon's sessions and attention list", async () => {
  const s = start(), c = connect(s.port); await c.open;
  c.ws.send(JSON.stringify({ type: "hello", token: TOKEN, device: "test" }));
  const r = await c.until((m) => m.type === "render");
  assert.equal(r.page.screen, "home");
  assert.match(text(r.page), /COMMAND CENTER/); assert.match(text(r.page), /Weekly Newsletter/);
  assert.deepEqual(s.agentd.calls.map((x) => x[0]).sort(), ["attention", "health", "sessions"]);   // the system check runs in the background
  c.ws.send(JSON.stringify({ type: "ping" })); await c.until((m) => m.type === "pong");
  c.ws.close(); await s.stop();
});

test("a typed utterance takes the same path as speech: 'what needs me' opens the needs list", async () => {
  const s = start(), c = connect(s.port); await c.open;
  c.ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
  await c.until((m) => m.type === "render" && m.page.screen === "home");
  assert.equal(s.gw.hear("What needs me?"), 1);
  const r = await c.until((m) => m.type === "render" && m.page && m.page.screen === "needs");
  assert.match(JSON.stringify(r.page), /NEEDS YOU/);
  c.ws.close(); await s.stop();
});

test("speech and free-talk settings are remembered across gateway restarts", async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gg-"));
  fs.writeFileSync(path.join(runDir, "g2-prefs.json"), JSON.stringify({ speech: false, free: true }));
  const s = start({ runDir }), c = connect(s.port); await c.open;
  c.ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
  assert.equal((await c.until((m) => m.type === "free")).on, true);
  assert.match(text((await c.until((m) => m.type === "render")).page), /muted/);
  c.ws.close(); await s.stop();
});

test("the simulator port is local-only and accepts only pages served from this computer, with the same token", async () => {
  const s = start();
  await new Promise((r) => setTimeout(r, 50));   // let it start listening
  assert.equal(s.gw.localWss.address().address, "127.0.0.1");
  assert.equal(await connect(s.port + 1, "http://203.0.113.9:5174").closed, 403);
  const c = connect(s.port + 1, "http://127.0.0.1:5174"); await c.open;
  c.ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
  assert.equal((await c.until((m) => m.type === "render")).page.screen, "home");
  c.ws.close(); await s.stop();
});

test("allowed origins: explicit list wins; otherwise localhost, the LAN address, and the certificate's name", () => {
  const g = { port: 3100, appPort: 5173, origins: null };
  assert.deepEqual(glassesOrigins(g, null, null), ["http://localhost:5173", "http://127.0.0.1:5173"]);
  assert.deepEqual(glassesOrigins(g, { host: "mac.example.ts.net" }, "192.0.2.5").slice(2), ["https://mac.example.ts.net:5173"]);   // plain LAN only when allowed
  assert.deepEqual(glassesOrigins({ ...g, allowPlainLan: true }, null, "192.0.2.5").slice(2), ["http://192.0.2.5:5173"]);
  assert.deepEqual(glassesOrigins({ ...g, origins: ["http://x:1"] }, null, null), ["http://x:1"]);
});

test("a hello with a same-length token in multi-byte characters is refused, not a crash", async () => {
  const s = start(), c = connect(s.port); await c.open;
  c.ws.send(JSON.stringify({ type: "hello", token: "é".repeat(48) }));
  assert.equal(await c.closed, 4003);
  const c2 = connect(s.port); await c2.open;               // still serving
  c2.ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
  assert.equal((await c2.until((m) => m.type === "render")).page.screen, "home");
  c2.ws.close(); await s.stop();
});
