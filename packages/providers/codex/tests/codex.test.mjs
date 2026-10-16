// Unit tests (no Codex process): node --test tests/unit/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CodexAdapter, mapStatus, itemsToViews } from "../src/CodexAdapter.mjs";

const TID = "01a11433-ec64-7ba2-bcaf-7ca5ee84b2ae";

test("mapStatus: native thread status + last turn outcome", () => {
  assert.equal(mapStatus({ type: "active", activeFlags: [] }), "working");
  assert.equal(mapStatus({ type: "active", activeFlags: ["waitingOnApproval"] }), "approval_required");
  assert.equal(mapStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }), "waiting_for_input");
  assert.equal(mapStatus({ type: "idle" }, "interrupted"), "interrupted");
  assert.equal(mapStatus({ type: "idle" }, "completed"), "complete");
  assert.equal(mapStatus({ type: "systemError" }), "failed");
  assert.equal(mapStatus({ type: "notLoaded" }), "idle");
  assert.equal(mapStatus({ type: "somethingNew" }), "unknown");
});

test("itemsToViews: user/agent/command/fileChange items", () => {
  const v = itemsToViews([{ id: "t1", items: [
    { type: "userMessage", id: "u", content: [{ type: "text", text: "hi" }] },
    { type: "reasoning", id: "r" },
    { type: "commandExecution", id: "c", command: "ls", cwd: "/w", status: "completed", exitCode: 0, aggregatedOutput: "a" },
    { type: "agentMessage", id: "a", text: "done" },
  ] }]);
  assert.deepEqual(v.map((x) => x.role), ["user", "tool", "assistant"]);
  assert.equal(v[1].tool.input.command, "ls");
});

// ---------- adapter with a fake app-server client ----------
class FakeClient extends EventEmitter {
  constructor() { super(); this.requests = []; this.replies = []; this.closed = false; this.version = "codex-cli test"; this.proc = { pid: 999999 }; }
  async start() { return { userAgent: "fake/0" }; }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/resume") { if (this.busy) throw Object.assign(new Error(`thread ${params.threadId} already has an active writer`), { code: -32600 }); return {}; }
    if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress" } };
    if (method === "turn/steer") return { turnId: params.expectedTurnId };
    return {};
  }
  reply(id, result) { this.replies.push({ id, result }); }
  notify() {}
  stop() { this.closed = true; this.emit("exit", { signal: "SIGTERM" }); }
  n(method, params) { this.emit("notification", { method, params }); }
}
function adapter(client) {
  const a = new CodexAdapter({ client, lockDir: fs.mkdtempSync(path.join(os.tmpdir(), "cxlock-")), owner: "t", enableQuestions: false });
  a.stopping = true; // no self-heal restarts in unit tests
  return a;
}
const tick = () => new Promise((r) => setImmediate(r));

test("send: streams deltas with offset ids, completes on its own turn, status ignores idle-before-turn/completed", async () => {
  const fc = new FakeClient(); const a = adapter(fc); await a.start();
  const evs = [];
  const run = (async () => { for await (const e of a.sendMessage(TID, "count")) evs.push(e); })();
  await tick(); await tick();
  fc.n("turn/started", { threadId: TID, turn: { id: "turn-1" } });
  fc.n("thread/status/changed", { threadId: TID, status: { type: "active", activeFlags: [] } });
  fc.n("item/agentMessage/delta", { threadId: TID, turnId: "turn-1", itemId: "m1", delta: "1\n" });
  fc.n("item/agentMessage/delta", { threadId: TID, turnId: "turn-1", itemId: "m1", delta: "2" });
  fc.n("item/agentMessage/delta", { threadId: TID, turnId: "turn-1", itemId: "m1", delta: "2" }); // different offset → distinct
  fc.n("item/completed", { threadId: TID, item: { type: "agentMessage", id: "m1", text: "1\n22" } });
  fc.n("thread/status/changed", { threadId: TID, status: { type: "idle" } }); // arrives before turn/completed
  fc.n("turn/completed", { threadId: TID, turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "1\n22" }] } });
  await run;
  const d = evs.filter((e) => e.type === "assistant_delta");
  assert.deepEqual(d.map((x) => x.id), ["d:m1:0", "d:m1:2", "d:m1:3"]);
  assert.deepEqual(evs.filter((e) => e.type === "status").map((e) => e.value), ["working", "complete"]);
  assert.equal(evs.at(-1).type, "turn_complete"); assert.equal(evs.at(-1).outcome, "complete");
});

test("send while a turn is active uses turn/steer with expectedTurnId", async () => {
  const fc = new FakeClient(); const a = adapter(fc); await a.start();
  const it1 = a.sendMessage(TID, "long task")[Symbol.asyncIterator](); await it1.next();
  fc.n("turn/started", { threadId: TID, turn: { id: "turn-1" } });
  const it2 = a.sendMessage(TID, "change direction")[Symbol.asyncIterator]();
  const first = await it2.next();
  assert.equal(first.value.type, "steer_accepted");
  const steer = fc.requests.find((r) => r.method === "turn/steer");
  assert.equal(steer.params.expectedTurnId, "turn-1");
});

test("approval request → globally unique id (thread:item) → decline reply; removal only on serverRequest/resolved", async () => {
  const fc = new FakeClient(); const a = adapter(fc); await a.start();
  const evs = []; a.on("event", (e) => evs.push(e));
  fc.emit("serverRequest", { id: 0, method: "item/commandExecution/requestApproval", params: { threadId: TID, turnId: "t", itemId: "exec-1", command: "touch x", cwd: "/w" } });
  const req = a.listApprovals()[0];
  assert.equal(req.requestId, `${TID}:exec-1`); assert.equal(req.kind, "tool"); assert.match(req.description, /touch x/);
  await a.respondToApproval(req.requestId, "deny");
  assert.deepEqual(fc.replies[0], { id: 0, result: { decision: "decline" } });
  assert.equal(a.listApprovals().length, 1); // still pending until server confirms
  fc.n("serverRequest/resolved", { threadId: TID, requestId: 0 });
  assert.equal(a.listApprovals().length, 0);
  assert.ok(evs.some((e) => e.type === "approval_resolved"));
});

test("structured question → answers keyed by question id, label matched case-insensitively", async () => {
  const fc = new FakeClient(); const a = adapter(fc); await a.start();
  fc.emit("serverRequest", { id: 7, method: "item/tool/requestUserInput", params: { threadId: TID, turnId: "t", itemId: "call_1", isBlocking: true, autoResolutionMs: null, questions: [{ id: "file_choice", header: "File", question: "Which file?", isOther: true, isSecret: false, options: [{ label: "option-a.txt" }, { label: "option-b.txt" }] }] } });
  const q = a.listApprovals()[0];
  assert.equal(q.kind, "question"); assert.deepEqual(q.question[0].options, ["option-a.txt", "option-b.txt"]);
  await a.respondToApproval(q.requestId, "approve", { answers: { _: "OPTION-B.TXT" } });
  assert.deepEqual(fc.replies[0].result, { answers: { file_choice: { answers: ["option-b.txt"] } } });
});

test("unknown server request kinds are never auto-answered (fail closed)", async () => {
  const fc = new FakeClient(); const a = adapter(fc); await a.start();
  const evs = []; a.on("event", (e) => evs.push(e));
  fc.emit("serverRequest", { id: 3, method: "item/somethingNew/request", params: { threadId: TID } });
  assert.equal(fc.replies.length, 0); assert.ok(evs.some((e) => e.type === "error"));
});

test("native writer conflict → WRITER_BUSY and our lock is released", async () => {
  const fc = new FakeClient(); fc.busy = true; const a = adapter(fc); await a.start();
  await assert.rejects(async () => { for await (const e of a.sendMessage(TID, "x")) break; }, { code: "WRITER_BUSY" });
  assert.equal(a.lock.read(TID), null);
});

test("app-server exit closes the active turn as failed and releases locks", async () => {
  const fc = new FakeClient(); const a = adapter(fc); await a.start();
  const evs = [];
  const run = (async () => { for await (const e of a.sendMessage(TID, "long")) evs.push(e); })();
  await tick(); await tick();
  fc.n("turn/started", { threadId: TID, turn: { id: "turn-1" } });
  fc.emit("exit", { signal: "SIGKILL" });
  await run;
  assert.equal(evs.at(-1).outcome, "failed"); assert.equal(a.lock.read(TID), null);
});
