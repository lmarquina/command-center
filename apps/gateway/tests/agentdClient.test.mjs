import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentdClient } from "../src/agentdClient.mjs";

const tmpSock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-ac-")), "d.sock");
const lines = (sock, on) => { let b = ""; sock.on("data", (d) => { b += d; let i; while ((i = b.indexOf("\n")) >= 0) { on(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("request: resolves with the result, skips streamed events, maps errors to codes", async () => {
  const p = tmpSock();
  const srv = net.createServer((s) => lines(s, (m) => {
    if (m.method === "bad") return s.write(JSON.stringify({ id: m.id, ok: false, error: { code: "SESSION_LOCKED", message: "busy", holder: "cli" } }) + "\n");
    s.write(JSON.stringify({ kind: "event", type: "message.sent" }) + "\n" + JSON.stringify({ id: m.id, ok: true, result: { echo: m.params } }) + "\n");
  })).listen(p);
  const c = new AgentdClient(p);
  assert.deepEqual(await c.request("x", { a: 1 }), { echo: { a: 1 } });
  await assert.rejects(c.request("bad"), { code: "SESSION_LOCKED", holder: "cli" });
  srv.close();
  await assert.rejects(new AgentdClient(tmpSock()).request("x"), { code: "AGENTD_DOWN" });
});

test("watch: while the daemon is down it retries one connection at a time, then reports status changes", async () => {
  const p = tmpSock(); let conns = 0; const socks = new Set();
  const c = new AgentdClient(p, { retryMs: 20 }); const events = [], status = [];
  c.on("event", (e) => events.push(e.n)); c.on("status", (s) => status.push(s.connected)); c.watch();
  await wait(150);                                // several failed attempts ("error" + "close" each time)
  const srv = net.createServer((s) => { conns++; socks.add(s); s.on("close", () => socks.delete(s)); s.on("error", () => {}); lines(s, () => s.write(JSON.stringify({ kind: "event", type: "status.changed", n: conns }) + "\n")); }).listen(p);
  await wait(120);
  assert.equal(conns, 1, "one watcher, not one per failed attempt"); assert.deepEqual(events, [1]);
  for (const s of socks) s.destroy();            // the daemon drops us
  await wait(120);
  assert.equal(conns, 2, "exactly one reconnect"); assert.deepEqual(status, [true, false, true]);
  c.close(); for (const s of socks) s.destroy(); srv.close();
});
