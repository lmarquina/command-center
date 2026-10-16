import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, merge } from "../src/config.mjs";

test("local.json overrides default.json key by key; arrays are replaced, not concatenated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cfg-"));
  fs.writeFileSync(path.join(dir, "default.json"), JSON.stringify({ providers: ["a", "b"], codex: { model: null, approvalPolicy: "on-request" } }));
  assert.deepEqual(loadConfig(dir).providers, ["a", "b"]);
  fs.writeFileSync(path.join(dir, "local.json"), JSON.stringify({ providers: ["a"], codex: { model: "x" } }));
  assert.deepEqual(loadConfig(dir), { providers: ["a"], codex: { model: "x", approvalPolicy: "on-request" } });
  assert.deepEqual(merge({ a: 1 }, { a: null }), { a: null });
  assert.throws(() => loadConfig(path.join(dir, "nope")), { code: "CONFIG_MISSING" });
});

test("the checked-in default config loads", () => { assert.ok(Array.isArray(loadConfig().providers)); });
