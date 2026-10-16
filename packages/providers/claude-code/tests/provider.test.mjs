import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ClaudeCodeProvider } from "../src/provider.mjs";

test("steering is the same call as sending: both return the client turn id", async () => {
  const sent = [];
  const adapter = Object.assign(new EventEmitter(), { send: async (id, m) => { sent.push([id, m]); return "turn-1"; }, listSessions: async () => [{ sessionId: "s1", title: "x" }] });
  const p = new ClaudeCodeProvider(adapter);
  assert.deepEqual([await p.startSend("s1", "a"), await p.steer("s1", "b")], [{ turnId: "turn-1" }, { turnId: "turn-1" }]);
  assert.deepEqual(sent, [["s1", "a"], ["s1", "b"]]);
  assert.deepEqual(await p.list(), [{ sessionId: "s1", title: "x", nativeId: "s1" }]);
});
