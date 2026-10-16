import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexProvider } from "../src/provider.mjs";

const TID = "22222222-3333-4444-8555-666666666666";

test("adapter events reach listeners as unified events; a decision we sent names the resolution", async () => {
  const adapter = Object.assign(new EventEmitter(), { respondToApproval: async () => ({ ok: true }) });
  const p = new CodexProvider(adapter); const seen = []; p.onEvent((e) => seen.push(e));
  adapter.emit("event", { id: "1", type: "approval_required", sessionId: TID, request: { requestId: "exec-1", kind: "tool", description: "Run: ls" } });
  await p.decide("exec-1", "deny", {}, "codex:exec-1");
  adapter.emit("event", { id: "2", type: "approval_resolved", sessionId: TID, requestId: "exec-1" });   // Codex reports no decision
  assert.deepEqual(seen.map((e) => [e.type, e.sessionId]), [["approval.requested", `codex:${TID}`], ["approval.denied", `codex:${TID}`]]);
});

test("startSend returns as soon as the turn is accepted and keeps draining the stream", async () => {
  let drained = false;
  const adapter = Object.assign(new EventEmitter(), {
    async *sendMessage() { yield { type: "status" }; yield { type: "sent", turnId: "t1", steered: false }; await new Promise((r) => setTimeout(r, 10)); yield { type: "turn_complete" }; drained = true; },
  });
  assert.deepEqual(await new CodexProvider(adapter).startSend(TID, "hi"), { turnId: "t1", steered: false });
  assert.equal(drained, false);
  await new Promise((r) => setTimeout(r, 40)); assert.equal(drained, true);
});
