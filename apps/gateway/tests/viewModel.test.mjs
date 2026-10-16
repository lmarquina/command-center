import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHome, foldLive } from "../src/viewModel.mjs";

test("buildHome: needs-you first, working excludes sessions waiting on the user, recent sorted", () => {
  const sessions = [
    { sessionId: "codex:a", provider: "codex", title: "Research", status: "idle", updatedAt: "2026-10-01" },
    { sessionId: "claude-code:b", provider: "claude-code", title: "Deck Builder", status: "idle", updatedAt: "2026-10-05" },
    { sessionId: "cowork:cse_X", provider: "cowork", title: "Client Agent", status: "unknown", updatedAt: "2026-10-03" },
    { sessionId: "chatgpt:c", provider: "chatgpt", title: "Old chat", status: "unknown" },
  ];
  const attention = [{ kind: "approval", sessionId: "cowork:cse_X", provider: "cowork", requestId: "cowork:cse_X#approval", text: "Use folder" }];
  const live = {}; foldLive(live, { type: "agent.started", sessionId: "codex:a", at: new Date(Date.now() - 37000).toISOString() });
  foldLive(live, { type: "status.changed", sessionId: "cowork:cse_X", status: "approval_required", at: new Date().toISOString() });
  const h = buildHome({ sessions, attention, live });
  assert.deepEqual(h.counts, { needsYou: 1, working: 1 });
  assert.equal(h.needsYou[0].headline, "Approval required"); assert.equal(h.needsYou[0].providerLabel, "Cowork");
  assert.equal(h.working[0].sessionId, "codex:a"); assert.ok(h.working[0].forSeconds >= 36);
  assert.deepEqual(h.recent.map((r) => r.sessionId), ["claude-code:b", "chatgpt:c"]);
  const many = Array.from({ length: 40 }, (_, i) => ({ sessionId: `codex:${i}`, provider: "codex", title: `t${i}`, updatedAt: `2026-10-${String(1 + (i % 9)).padStart(2, "0")}` }));
  const h2 = buildHome({ sessions: [...many, { sessionId: "chatgpt:z", provider: "chatgpt", title: "undated" }], attention: [], live: {} });
  assert.ok(h2.recent.some((r) => r.provider === "chatgpt"), "undated provider hidden");
});
test("foldLive: working 'since' survives approval round-trip; terminal events end it", () => {
  const L = {};
  foldLive(L, { type: "agent.started", sessionId: "s", at: "2026-10-06T10:00:00Z" });
  foldLive(L, { type: "status.changed", sessionId: "s", status: "approval_required", at: "2026-10-06T10:00:05Z" });
  foldLive(L, { type: "status.changed", sessionId: "s", status: "working", at: "2026-10-06T10:00:09Z" });
  assert.equal(L.s.since, "2026-10-06T10:00:00Z");
  foldLive(L, { type: "agent.interrupted", sessionId: "s", at: "2026-10-06T10:01:00Z" });
  assert.equal(L.s.status, "interrupted");
});
