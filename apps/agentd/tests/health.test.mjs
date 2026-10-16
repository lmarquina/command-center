import { test } from "node:test";
import assert from "node:assert/strict";
import { healthChecks } from "../src/health.mjs";

const providers = { "claude-code": { ok: true }, codex: { ok: true }, cowork: { ok: true }, chatgpt: { ok: true } };
const bridge = { extension: "0.4.0", cowork: { ok: true, tab: "ok", signedIn: true }, chatgpt: { ok: true, tab: "ok", signedIn: true } };
const failing = (c) => c.filter((x) => !x.ok).map((x) => x.id);

test("everything up: every check passes, one per moving part", () => {
  const c = healthChecks({ providers, bridge, desktopRunning: true });
  assert.deepEqual(c.map((x) => x.id), ["chrome", "cowork", "chatgpt", "desktop", "claude-code", "codex"]);
  assert.deepEqual(failing(c), []);
});

test("each failure says what is wrong and what to do", () => {
  assert.deepEqual(healthChecks({ providers, bridge: new Error("BRIDGE_DOWN"), desktopRunning: true }).filter((x) => !x.ok).map((x) => x.label), ["Chrome extension not connected: open Chrome"]);
  const out = healthChecks({ providers: { ...providers, codex: { ok: false, error: "codex binary not found" } }, bridge: { ...bridge, cowork: { tab: "ok", signedIn: false }, chatgpt: { tab: "missing" } }, desktopRunning: false });
  assert.deepEqual(out.filter((x) => !x.ok).map((x) => x.label), ["Cowork: signed out of claude.ai", "ChatGPT: can't open chatgpt.com in Chrome", "Claude Desktop closed: new Cowork tasks can't start", "Codex: codex binary not found"]);
});

test("only configured providers are checked", () => {
  assert.deepEqual(healthChecks({ providers: { codex: { ok: true } }, desktopRunning: false }).map((x) => x.id), ["codex"]);
});
