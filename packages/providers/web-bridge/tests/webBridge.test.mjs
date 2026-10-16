import { test } from "node:test";
import assert from "node:assert/strict";

test("Cowork tasks cannot be created without the Desktop launcher (no fake parity)", async () => {
  const { WebBridgeProvider } = await import("../src/webBridge.mjs");
  await assert.rejects(new WebBridgeProvider("cowork", {}).create({ firstMessage: "x", cwd: "/tmp" }), { code: "NOT_SUPPORTED" });
});
test("web bridge list: pushed sessions.changed events feed the list (no bridge call while fresh)", async () => {
  const { WebBridgeProvider } = await import("../src/webBridge.mjs");
  const { fromBridgeEvent } = await import("@command-center/core/events.mjs");
  let calls = 0; const client = { listeners: new Set(), request: async () => { calls++; return { sessions: [{ sessionId: "cse_A", kind: "cowork", title: "Old" }] }; } };
  const p = new WebBridgeProvider("cowork", client);
  assert.equal((await p.list()).length, 1); assert.equal(calls, 1);          // first time: asks the bridge
  const [ev] = fromBridgeEvent({ event: "session.listChanged", sessionId: "_list", at: "t", sessions: [{ sessionId: "cse_A", kind: "cowork", title: "A", status: "working" }, { sessionId: "chat:11111111-1111-1111-1111-111111111111", kind: "chat", title: "B", status: "waiting_for_input" }] });
  assert.equal(ev.type, "sessions.changed");
  for (const l of client.listeners) l(ev);
  const list = await p.list(); assert.equal(calls, 1);                        // served from the pushed list
  assert.deepEqual(list.map((x) => [x.title, x.status]), [["A", "working"], ["B", "waiting_for_input"]]);
});

test("the list keeps each session's last-activity time, so lists sort by real recency", async () => {
  const { WebBridgeProvider } = await import("../src/webBridge.mjs");
  const client = { listeners: new Set(), request: async () => ({ sessions: [{ sessionId: "cse_a", kind: "cowork", title: "A", updatedAt: "2026-10-14T19:59:00.000Z" }, { sessionId: "chat:b", kind: "chat", title: "B" }] }) };
  const rows = await new WebBridgeProvider("cowork", client).list();
  assert.deepEqual(rows.map((r) => [r.nativeId, r.updatedAt]), [["cse_a", "2026-10-14T19:59:00.000Z"], ["chat:b", undefined]]);
});
