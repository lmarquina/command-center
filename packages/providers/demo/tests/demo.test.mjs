import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionCore } from "@command-center/core/SessionCore.mjs";
import { DemoProvider } from "../src/demoProvider.mjs";
import { demoWorld } from "../src/world.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function core() {
  const w = demoWorld();
  return new SessionCore({ providers: Object.fromEntries(Object.keys(w).map((p) => [p, new DemoProvider(p, w[p], { pace: 0.01 })])) });
}

test("every demo id is a valid canonical id, so the whole UI works on it", async () => {
  const c = core(); await c.start();
  const { sessions, degraded } = await c.listSessions();
  assert.deepEqual(degraded, {});
  assert.deepEqual([...new Set(sessions.map((s) => s.provider))].sort(), ["chatgpt", "claude-code", "codex", "cowork"]);
  assert.ok(sessions.length >= 10);
});

test("the waiting approval shows up, and approving it runs the turn to completion", async () => {
  const c = core(); const types = []; c.on("event", (e) => types.push(e.type)); await c.start(); await wait(20);
  const req = c.needsAttention().find((a) => a.kind === "approval");
  assert.match(req.text, /migrate/);
  await c.approve(req.requestId, { client: "g2" }); await wait(200);
  assert.ok(types.includes("approval.approved") && types.includes("agent.completed"));
  assert.ok(!c.needsAttention().some((a) => a.kind === "approval"));
  const s = await c.getSession(req.sessionId); assert.match(s.messages.at(-1).text, /Dry run passed/);
});

test("a question to ChatGPT creates a chat with an answer; a message to a session gets a reply", async () => {
  const c = core(); await c.start();
  const q = await c.createSession({ provider: "chatgpt", firstMessage: "When was Lincoln born?", client: "g2" }); await wait(200);
  assert.match((await c.getSession(q.sessionId)).messages.at(-1).text, /February 12, 1809/);
  const cc = (await c.listSessions()).sessions.find((s) => s.provider === "claude-code");
  for await (const e of c.send(cc.sessionId, "Run the tests too.", { client: "g2" })) if (e.type === "agent.completed") break;
  assert.match((await c.getSession(cc.sessionId)).messages.at(-1).text, /212 passed/);
});
