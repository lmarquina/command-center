// Unit tests (no Claude process, no network): node --test tests/unit/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StatusMachine } from "../src/statusMachine.mjs";
import { Deduper } from "@command-center/core/dedupe.mjs";
import { EventNormalizer } from "../src/eventNormalizer.mjs";
import { PermissionBroker } from "../src/permissionBroker.mjs";
import { SessionRuntime } from "../src/sessionRuntime.mjs";
import { toSummary, toMessageViews, matchesQuery } from "../src/sessionView.mjs";
import * as FX from "./fixtures/sdk-sequences.mjs";

// ---------- session normalization ----------
test("toSummary: canonical id, title fallback order, ISO timestamps, live status", () => {
  const info = { sessionId: FX.SID, summary: "auto summary", customTitle: undefined, firstPrompt: "first", lastModified: 1790000000000, createdAt: 1789990000000, cwd: "/w", gitBranch: "main", tag: "poc" };
  const s = toSummary(info, null);
  assert.equal(s.sessionId, FX.SID); assert.equal(s.title, "auto summary"); assert.equal(s.status, "idle"); assert.equal(s.live, false);
  assert.match(s.updatedAt, /^2026-/);
  assert.equal(toSummary({ ...info, customTitle: "Custom" }, { status: "working" }).title, "Custom");
  assert.equal(toSummary({ ...info, customTitle: "Custom" }, { status: "working" }).status, "working");
  assert.ok(matchesQuery(s, "poc") && matchesQuery(s, FX.SID.slice(0, 8)) && !matchesQuery(s, "nomatch"));
});
test("toMessageViews: user text, assistant text + tool_use, tool_result", () => {
  const v = toMessageViews([
    { type: "user", uuid: "u1", message: { content: "hello" } },
    { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x" } }] } },
    { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "DATA", is_error: false }] } },
  ]);
  assert.deepEqual(v.map((x) => x.role), ["user", "assistant", "assistant", "tool"]);
  assert.equal(v[2].tool.name, "Read"); assert.equal(v[3].toolResult.preview, "DATA");
});

// ---------- event normalization + dedupe ----------
test("EventNormalizer: deterministic delta ids with contiguous offsets; tool_call/tool_result ids from native ids", () => {
  const n = new EventNormalizer();
  const evs = FX.simpleTurn("c1").flatMap((m) => n.normalize(m));
  const deltas = evs.filter((e) => e.type === "assistant_delta");
  assert.deepEqual(deltas.map((d) => d.id), ["d:msg_1:0:0", "d:msg_1:0:3"]);
  assert.equal(evs.find((e) => e.type === "assistant_message").id, "m:msg_1:0");
  const n2 = new EventNormalizer();
  const t = FX.steeredTurn("a", "b").flatMap((m) => n2.normalize(m));
  assert.equal(t.find((e) => e.type === "tool_call").id, "t:toolu_1");
  assert.equal(t.find((e) => e.type === "tool_result").id, "r:toolu_1");
});
test("replaying the same SDK stream yields identical ids → Deduper suppresses all duplicates", () => {
  const d = new Deduper();
  const run = () => { const n = new EventNormalizer(); return FX.simpleTurn("c1").flatMap((m) => n.normalize(m)); };
  const first = run().filter((e) => d.firstTime(e.id)).length;
  const second = run().filter((e) => d.firstTime(e.id)).length;
  assert.ok(first > 0); assert.equal(second, 0);
});

// ---------- status machine ----------
test("StatusMachine: approval does not flip to idle; returns to working; turn end → complete", () => {
  const m = new StatusMachine();
  const seq = [];
  for (const f of [{ type: "turn_start" }, { type: "request_opened", requestId: "r1", kind: "tool" }, { type: "noise" }, { type: "request_closed", requestId: "r1" }, { type: "turn_end", subtype: "success" }]) seq.push(...m.apply(f));
  assert.deepEqual(seq, ["working", "approval_required", "working", "complete"]);
});
test("StatusMachine: question → waiting_for_input; tool request has precedence when both pending", () => {
  const m = new StatusMachine();
  m.apply({ type: "turn_start" });
  assert.deepEqual(m.apply({ type: "request_opened", requestId: "q", kind: "question" }), ["waiting_for_input"]);
  assert.deepEqual(m.apply({ type: "request_opened", requestId: "t", kind: "tool" }), ["approval_required"]);
  assert.deepEqual(m.apply({ type: "request_closed", requestId: "t" }), ["waiting_for_input"]);
});
test("StatusMachine: interrupt → interrupted; error without interrupt → failed; process exit mid-turn → failed", () => {
  const a = new StatusMachine(); a.apply({ type: "turn_start" }); a.apply({ type: "interrupt_sent" });
  assert.deepEqual(a.apply({ type: "turn_end", subtype: "error_during_execution", terminal: "aborted_streaming" }), ["interrupted"]);
  const b = new StatusMachine(); b.apply({ type: "turn_start" });
  assert.deepEqual(b.apply({ type: "turn_end", subtype: "error_max_turns" }), ["failed"]);
  const c = new StatusMachine(); c.apply({ type: "turn_start" });
  assert.deepEqual(c.apply({ type: "process_exit", error: true }), ["failed"]);
});

// ---------- permission broker ----------
const opts = (id) => ({ requestId: id, toolUseID: "toolu_" + id, displayName: "Write", description: "x.txt", signal: new AbortController().signal });
test("PermissionBroker: request waits until external approve → allow with original input", async () => {
  const opened = []; const b = new PermissionBroker({ onOpen: (r) => opened.push(r) });
  let settled = false;
  const p = b.callbackFor(FX.SID)("Write", { file_path: "x.txt", content: "Y" }, opts("r1")).then((r) => ((settled = true), r));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false); assert.equal(opened[0].requestId, "r1"); assert.equal(opened[0].kind, "tool"); assert.equal(b.list().length, 1);
  b.decide("r1", "approve");
  assert.deepEqual(await p, { behavior: "allow", updatedInput: { file_path: "x.txt", content: "Y" } });
  assert.equal(b.list().length, 0);
});
test("PermissionBroker: deny → deny with message; unknown/double decisions rejected", async () => {
  const b = new PermissionBroker();
  const p = b.callbackFor(FX.SID)("Bash", { command: "touch x" }, opts("r2"));
  b.decide("r2", "deny");
  assert.equal((await p).behavior, "deny");
  assert.throws(() => b.decide("r2", "approve"), { code: "NO_SUCH_REQUEST" });
});
test("PermissionBroker: AskUserQuestion → kind question; answer maps label onto SDK answers", async () => {
  const b = new PermissionBroker();
  const input = { questions: [{ question: "Which file?", header: "File", multiSelect: false, options: [{ label: "option-a.txt", description: "" }, { label: "option-b.txt", description: "" }] }] };
  const p = b.callbackFor(FX.SID)("AskUserQuestion", input, opts("q1"));
  const req = b.get("q1");
  assert.equal(req.kind, "question"); assert.deepEqual(req.question[0].options, ["option-a.txt", "option-b.txt"]);
  b.decide("q1", "approve", { answers: { _: "OPTION-B.TXT" } });
  assert.deepEqual((await p).updatedInput.answers, { "Which file?": "option-b.txt" });
});
test("PermissionBroker: SDK abort (turn ended/interrupted) cancels the pending request", async () => {
  const closed = []; const b = new PermissionBroker({ onClose: (r, d) => closed.push(d) });
  const ac = new AbortController();
  const p = b.callbackFor(FX.SID)("Write", {}, { ...opts("r3"), signal: ac.signal });
  ac.abort();
  assert.equal((await p).behavior, "deny"); assert.deepEqual(closed, ["cancelled"]); assert.equal(b.list().length, 0);
});

// ---------- session runtime with a fake SDK query ----------
function fakeQuery(script) {
  return ({ prompt }) => {
    const sent = []; const waiters = [];
    (async () => { for await (const m of prompt) { sent.push(m); waiters.splice(0).forEach((w) => w()); } })();
    const need = async (n) => { while (sent.length < n) await new Promise((r) => waiters.push(r)); return sent.map((m) => m.uuid); };
    let interrupted = false;
    return {
      async *[Symbol.asyncIterator]() { yield* script(need, () => interrupted); },
      interrupt: async () => { interrupted = true; return { still_queued: [] }; },
      close() {},
    };
  };
}
function runtimeWith(script) {
  const events = []; const broker = new PermissionBroker();
  const rt = new SessionRuntime({ sessionId: FX.SID, isNew: false, broker, sdkOptions: {}, emit: (e) => events.push(e), queryImpl: fakeQuery(script) });
  return { rt, events };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test("SessionRuntime: client turn correlated by replay uuid; unsolicited turn not confused with it", async () => {
  const { rt, events } = runtimeWith(async function* (need) { const [u] = await need(1); yield* FX.unsolicitedThenClient(u); });
  const turnId = rt.send("hi");
  await rt.done; await settle();
  const starts = events.filter((e) => e.type === "turn_started");
  assert.deepEqual(starts.map((s) => s.origin), ["unsolicited", "client"]);
  const mine = events.filter((e) => e.type === "turn_complete" && e.turnId === turnId);
  assert.equal(mine.length, 1); assert.equal(mine[0].result, "HI");
});
test("SessionRuntime: steering message replayed mid-turn → steer_accepted + merged completion", async () => {
  const { rt, events } = runtimeWith(async function* (need) { const [a] = await need(1); const evs = FX.steeredTurn(a, "PLACEHOLDER"); yield* evs.slice(0, 4); const [, b] = await need(2); yield* FX.steeredTurn(a, b).slice(4); });
  const t1 = rt.send("read three files");
  await settle();
  const t2 = rt.send("only a");
  await rt.done; await settle();
  assert.ok(events.some((e) => e.type === "steer_accepted" && e.turnId === t2 && e.intoTurn === t1));
  const done = events.filter((e) => e.type === "turn_complete");
  assert.deepEqual(done.map((e) => e.turnId).sort(), [t1, t2].sort());
  assert.equal(done.find((e) => e.turnId === t2).mergedInto, t1);
});
test("SessionRuntime: interrupt → status interrupted + turn_complete interrupted", async () => {
  let release; const gate = new Promise((r) => (release = r));
  const { rt, events } = runtimeWith(async function* (need) { const [u] = await need(1); const s = FX.interruptedTurn(u); yield* s.slice(0, 5); await gate; yield s[5]; });
  const t = rt.send("story");
  await settle();
  await rt.interrupt(); release();
  await rt.done; await settle();
  assert.equal(events.find((e) => e.type === "turn_complete" && e.turnId === t).outcome, "interrupted");
  assert.ok(events.some((e) => e.type === "status" && e.value === "interrupted"));
});
test("SessionRuntime: process exit mid-turn closes the open turn as failed (client never hangs)", async () => {
  const { rt, events } = runtimeWith(async function* (need) { const [u] = await need(1); yield* FX.simpleTurn(u).slice(0, 4); throw new Error("Claude Code process terminated by signal SIGKILL"); });
  const t = rt.send("count");
  await rt.done; await settle();
  assert.equal(events.find((e) => e.type === "turn_complete" && e.turnId === t).outcome, "failed");
  assert.ok(events.some((e) => e.type === "status" && e.value === "failed"));
});
test("SessionRuntime: CLI reporting another session id fails closed", async () => {
  const { rt, events } = runtimeWith(async function* () { yield* FX.wrongSession(); await new Promise(() => {}); });
  rt.send("x");
  await settle();
  assert.ok(events.some((e) => e.type === "error" && /expected/.test(e.message)));
  assert.equal(rt.closed, true);
});
test("SessionRuntime: duplicate SDK messages (replay after reconnect) are not re-emitted", async () => {
  const { rt, events } = runtimeWith(async function* (need) { const [u] = await need(1); const s = FX.simpleTurn(u); yield* s.slice(0, 7); yield* s.slice(2, 7); yield* s.slice(7); });
  rt.send("count");
  await rt.done; await settle();
  const ids = events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(events.filter((e) => e.type === "assistant_message").length, 1);
});

test("adapter: respawned runtime for the same session never reuses event ids; seq stays monotonic", async () => {
  const { ClaudeCodeAdapter } = await import("../src/ClaudeCodeAdapter.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cclock-"));
  const sdkImpl = {
    getSessionInfo: async () => ({ sessionId: FX.SID, cwd: os.tmpdir(), summary: "x", lastModified: Date.now() }),
    query: fakeQuery(async function* (need) { const [u] = await need(1); yield* FX.simpleTurn(u); }),
  };
  const a = new ClaudeCodeAdapter({ sdkImpl, lockDir: dir, owner: "t" });
  const evs = []; a.on("event", (e) => evs.push(e));
  for (let i = 0; i < 2; i++) { for await (const e of a.sendMessage(FX.SID, "count")) { /* drain */ } await a.closeSession(FX.SID); }
  const nonNative = evs.filter((e) => e.type === "status").map((e) => e.id);
  assert.equal(new Set(nonNative).size, nonNative.length);
  const seqs = evs.map((e) => e.seq);
  assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
});
