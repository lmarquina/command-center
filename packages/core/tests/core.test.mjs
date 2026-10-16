// session-core unit tests (no real providers): node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionId, sessionIdFor, parseRequestId, requestIdFor } from "../src/ids.mjs";
import { fromAdapterEvent, fromBridgeEvent } from "../src/events.mjs";
import { LockManager } from "../src/locks.mjs";
import { AttentionBoard } from "../src/attention.mjs";
import { SessionCore } from "../src/SessionCore.mjs";

const CC = "11111111-1111-4111-8111-111111111111", CX = "22222222-3333-4444-8555-666666666666";

test("ids: canonical prefixes, validation, request routing", () => {
  assert.equal(sessionIdFor("claude-code", CC), `claude-code:${CC}`);
  assert.equal(sessionIdFor("chatgpt", `chatgpt:${CC}`), `chatgpt:${CC}`);
  assert.equal(parseSessionId("cowork:cse_01VZusLcGAzC2eXoQHsJLxwX").native, "cse_01VZusLcGAzC2eXoQHsJLxwX");
  assert.equal(parseSessionId(`cowork:chat:${CC}`).native, `chat:${CC}`);
  for (const bad of ["Untitled", `claude-code:not-a-uuid`, `gemini:${CC}`, "cowork:../etc"]) assert.throws(() => parseSessionId(bad), { code: "BAD_SESSION_ID" });
  assert.deepEqual(parseRequestId(requestIdFor("codex", `${CX}:exec-1`)), { provider: "codex", native: `${CX}:exec-1` });
});

test("adapter events → unified vocabulary (approval decided by what we sent)", () => {
  const pending = new Map();
  const m = (e) => fromAdapterEvent("codex", { sessionId: CX, at: "t", ...e }, pending);
  assert.equal(m({ id: "d:x:0", type: "assistant_delta", text: "a" })[0].type, "agent.output.delta");
  const ar = m({ id: "a:1", type: "approval_required", request: { requestId: `${CX}:exec-1`, kind: "tool", description: "Run: ls" } })[0];
  assert.equal(ar.type, "approval.requested"); assert.equal(ar.request.requestId, `codex:${CX}:exec-1`);
  pending.get(`codex:${CX}:exec-1`).decision = "deny";
  assert.equal(m({ id: "ar:1", type: "approval_resolved", requestId: `${CX}:exec-1` })[0].type, "approval.denied");
  assert.equal(m({ id: "c:1", type: "turn_complete", outcome: "interrupted" })[0].type, "agent.interrupted");
  assert.deepEqual(m({ id: "s", type: "sent" }), []);
  const q = fromAdapterEvent("claude-code", { sessionId: CC, id: "a:q", type: "question", request: { requestId: "r9", kind: "question", question: [{ text: "Which?", options: ["A", "B"] }] } }, pending)[0];
  assert.equal(q.type, "question.requested"); assert.deepEqual(q.request.question[0].options, ["A", "B"]);
  assert.equal(fromAdapterEvent("claude-code", { sessionId: CC, id: "ar:q", type: "approval_resolved", requestId: "r9", decision: "answered" }, pending)[0].type, "question.answered");
});

test("bridge events → unified (cowork vs chatgpt routing; status-driven start)", () => {
  const ev = fromBridgeEvent({ event: "session.statusChanged", sessionId: "cse_01VZusLcGAzC2eXoQHsJLxwX", from: "idle", status: "working", at: "t1" });
  assert.deepEqual(ev.map((e) => e.type), ["status.changed", "agent.started"]);
  assert.equal(ev[0].sessionId, "cowork:cse_01VZusLcGAzC2eXoQHsJLxwX");
  const g = fromBridgeEvent({ event: "session.messageAdded", provider: "chatgpt", sessionId: `chatgpt:${CC}`, role: "assistant", key: "a-1", text: "OK", at: "t2" });
  assert.equal(g[0].sessionId, `chatgpt:${CC}`); assert.equal(g[0].type, "agent.output.delta");
  assert.equal(fromBridgeEvent({ event: "session.messageFinal", provider: "chatgpt", sessionId: `chatgpt:${CC}`, key: "a-1", text: "OK done", at: "t9" })[0].type, "agent.output.complete");
  const ap = fromBridgeEvent({ event: "session.approvalRequested", sessionId: "cse_01VZusLcGAzC2eXoQHsJLxwX", approval: { detail: "use folder" }, at: "t3" })[0];
  assert.equal(ap.request.requestId, "cowork:cse_01VZusLcGAzC2eXoQHsJLxwX#approval");
  assert.deepEqual(fromBridgeEvent({ event: "session.statusChanged", sessionId: "garbage id" }), []);
});

test("LockManager: one writer, renew, expiry, takeover, client required", () => {
  let now = 0; const L = new LockManager({ ttlMs: 1000, now: () => now });
  L.acquire("s", "g2"); L.acquire("s", "g2");
  assert.throws(() => L.acquire("s", "web-ui"), { code: "SESSION_LOCKED" });
  assert.equal(L.acquire("s", "web-ui", { takeover: true }).tookOverFrom, "g2");
  now = 5000; assert.equal(L.holder("s"), null); L.acquire("s", "g2");
  assert.throws(() => L.acquire("s"), { code: "NO_CLIENT_ID" });
});

test("AttentionBoard: approvals first, cleared on resolution, review on completion, ack", () => {
  const A = new AttentionBoard(); const S = `codex:${CX}`;
  A.apply({ type: "agent.completed", sessionId: S, provider: "codex", result: "Done", at: "1" });
  A.apply({ type: "approval.requested", sessionId: S, provider: "codex", at: "2", request: { requestId: "codex:r1", description: "Run: ls" } });
  assert.deepEqual(A.list().map((i) => i.kind), ["approval", "review"]);
  A.apply({ type: "approval.approved", sessionId: S, provider: "codex", requestId: "codex:r1" });
  assert.deepEqual(A.list().map((i) => i.kind), ["review"]);
  A.ack(S); assert.equal(A.list().length, 0);
});

// ---------- SessionCore with fake providers ----------
function fakeProvider(name, script) {
  const l = new Set();
  return { listeners: l, onEvent: (cb) => { l.add(cb); }, push: (e) => { for (const f of l) f(e); },
    start: async () => ({}), stop: async () => {}, list: async () => [{ nativeId: name === "codex" ? CX : CC, title: `${name} session`, updatedAt: "2026-10-06" }],
    get: async (id) => ({ nativeId: id, messages: [], totalMessages: 0 }), status: async () => ({ status: "idle" }),
    startSend: async (id, msg) => script(id, msg), steer: async () => ({ ok: true }), interrupt: async () => ({ interrupted: true }),
    decide: async (...a) => { l.decided = a; return {}; } };
}
test("SessionCore.send streams until its own turn ends; duplicates suppressed; seq monotonic", async () => {
  let prov;
  prov = fakeProvider("codex", async () => { setTimeout(() => {
    const ev = (id, type, x = {}) => prov.push({ id, type, provider: "codex", sessionId: `codex:${CX}`, at: "t", turnId: "T1", ...x });
    ev("1", "agent.started"); ev("2", "agent.output.delta", { text: "hi" }); ev("2", "agent.output.delta", { text: "hi" }); // dup
    ev("x", "agent.completed", { turnId: "OTHER" }); ev("3", "agent.completed", { result: "hi" });
  }, 5); return { turnId: "T1" }; });
  const core = new SessionCore({ providers: { codex: prov } });
  const got = []; for await (const e of core.send(`codex:${CX}`, "hello", { client: "cli" })) got.push(e);
  assert.deepEqual(got.map((e) => e.type), ["message.sent", "agent.started", "agent.output.delta", "agent.completed", "agent.completed"]);
  assert.equal(got.at(-1).turnId, "T1");
  const seqs = got.slice(1).map((e) => e.seq); assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
});
test("SessionCore: writer lease enforced across clients; reads unrestricted", async () => {
  const prov = fakeProvider("claude-code", async () => ({ turnId: "T" }));
  const core = new SessionCore({ providers: { "claude-code": prov } });
  await core.interrupt(`claude-code:${CC}`, { client: "g2" });
  await assert.rejects(core.interrupt(`claude-code:${CC}`, { client: "web-ui" }), { code: "SESSION_LOCKED" });
  assert.equal((await core.getStatus(`claude-code:${CC}`)).writer.owner, "g2");
});
test("SessionCore: capability guards (no fake parity)", async () => {
  const core = new SessionCore({ providers: { chatgpt: fakeProvider("chatgpt", async () => ({})), cowork: fakeProvider("cowork", async () => ({})) } });
  await assert.rejects(core.steer(`chatgpt:${CC}`, "x", { client: "cli" }), { code: "NOT_SUPPORTED" });
});
test("SessionCore: approve routes by request id, only for pending requests, takes the writer lease", async () => {
  const prov = fakeProvider("codex", async () => ({}));
  const core = new SessionCore({ providers: { codex: prov } });
  await assert.rejects(core.approve(`codex:${CX}:exec-9`, { client: "g2" }), { code: "NO_SUCH_REQUEST" });
  prov.push({ id: "a1", type: "approval.requested", provider: "codex", sessionId: `codex:${CX}`, at: "t", request: { requestId: `codex:${CX}:exec-9`, description: "Run: touch x" } });
  await core.approve(`codex:${CX}:exec-9`, { client: "g2" });
  assert.deepEqual(prov.listeners.decided.slice(0, 2), [`${CX}:exec-9`, "approve"]);
  assert.equal(core.locks.holder(`codex:${CX}`).owner, "g2");
});
test("SessionCore.listSessions: merges providers, reports a failing provider as degraded", async () => {
  const bad = fakeProvider("cowork", async () => ({})); bad.list = async () => { throw Object.assign(new Error("bridge down"), { code: "BRIDGE_DOWN" }); };
  const core = new SessionCore({ providers: { codex: fakeProvider("codex", async () => ({})), cowork: bad } });
  const r = await core.listSessions();
  assert.equal(r.sessions.length, 1); assert.equal(r.sessions[0].sessionId, `codex:${CX}`); assert.equal(r.degraded.cowork.code, "BRIDGE_DOWN");
});
