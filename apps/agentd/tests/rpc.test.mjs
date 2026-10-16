import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startRpcServer } from "../src/rpcServer.mjs";

function fakeCore() {
  return Object.assign(new EventEmitter(), {
    calls: [],
    locks: { list: () => [] },
    needsAttention: () => [{ sessionId: "codex:a", kind: "approval" }],
    async approve(requestId, o) { this.calls.push(["approve", requestId, o]); return { ok: true }; },
    async interrupt() { throw Object.assign(new Error("locked"), { code: "SESSION_LOCKED", holder: "web-ui" }); },
    async *send(sessionId, message) { yield { type: "message.sent", sessionId }; yield { type: "agent.output.complete", text: `re: ${message}` }; yield { type: "agent.completed", sessionId }; },
  });
}
const sockPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-rpc-")), "d.sock");
function client(p) {
  const s = net.createConnection(p), lines = [], waiters = []; let buf = "";
  s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } for (const w of waiters.splice(0)) w(); });
  const until = async (pred) => { for (;;) { const m = lines.find(pred); if (m) return m; await new Promise((r) => waiters.push(r)); } };
  return { call: (id, method, params) => { s.write(JSON.stringify({ id, method, params }) + "\n"); return until((m) => m.id === id); }, until, lines, end: () => s.destroy() };
}

test("calls are routed to the core with the caller's client id; errors keep their code and lock holder", async () => {
  const core = fakeCore(), p = sockPath(), rpc = await startRpcServer({ core, sockPath: p, health: { codex: { ok: true } } });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  const c = client(p);
  assert.deepEqual((await c.call("1", "ping")).result.providers, { codex: { ok: true } });
  assert.equal((await c.call("2", "attention")).result[0].kind, "approval");
  await c.call("3", "approve", { requestId: "codex:r1", client: "g2" });
  assert.deepEqual(core.calls, [["approve", "codex:r1", { client: "g2", takeover: undefined }]]);
  assert.deepEqual((await c.call("4", "interrupt", { sessionId: "codex:a", client: "cli" })).error, { code: "SESSION_LOCKED", message: "locked", holder: "web-ui" });
  assert.equal((await c.call("5", "nope")).error.code, "UNKNOWN_METHOD");
  c.end(); await rpc.close(); assert.equal(fs.existsSync(p), false);
});

test("send streams the turn's events and resolves with the final one; detach returns once it is accepted", async () => {
  const p = sockPath(), rpc = await startRpcServer({ core: fakeCore(), sockPath: p }), c = client(p);
  const done = await c.call("1", "send", { sessionId: "codex:a", message: "hi", client: "cli" });
  assert.equal(done.result.type, "agent.completed");
  assert.deepEqual(c.lines.filter((m) => m.kind === "event").map((m) => m.type), ["message.sent", "agent.output.complete", "agent.completed"]);
  const d = await c.call("2", "send", { sessionId: "codex:a", message: "hi", client: "cli", detach: true });
  assert.equal(d.result.detached, true);
  c.end(); await rpc.close();
});

test("watchers receive every core event; a second daemon on the same socket is refused; a stale socket is replaced", async () => {
  const core = fakeCore(), p = sockPath(), seen = [], rpc = await startRpcServer({ core, sockPath: p, onEvent: (e) => seen.push(e.type) }), c = client(p);
  await c.call("1", "watch");
  core.emit("event", { type: "status.changed", sessionId: "codex:a", status: "working" });
  assert.equal((await c.until((m) => m.kind === "event")).status, "working");
  assert.deepEqual(seen, ["status.changed"]);
  await assert.rejects(startRpcServer({ core: fakeCore(), sockPath: p }), { code: "ALREADY_RUNNING" });
  c.end(); await rpc.close();
  fs.writeFileSync(p, "");   // what a crash leaves behind
  const again = await startRpcServer({ core: fakeCore(), sockPath: p }); await again.close();
});
