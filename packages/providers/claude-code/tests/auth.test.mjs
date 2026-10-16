import { test } from "node:test";
import assert from "node:assert/strict";
import { setupClaudeAuth } from "../src/auth.mjs";

test("API key by default: read from the Keychain into the environment the SDK uses", () => {
  const env = {}; const seen = [];
  assert.deepEqual(setupClaudeAuth({}, { env, keychain: (s) => { seen.push(s); return "sk-ant-test"; } }), { ok: true, mode: "apiKey" });
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test"); assert.deepEqual(seen, ["command-center-anthropic"]);
});

test("a missing key is reported, not guessed; an existing environment key wins; login mode touches nothing", () => {
  assert.equal(setupClaudeAuth({ keychainService: "x" }, { env: {}, keychain: () => null }).code, "NO_API_KEY");
  const env = { ANTHROPIC_API_KEY: "from-env" };
  setupClaudeAuth({}, { env, keychain: () => "other" }); assert.equal(env.ANTHROPIC_API_KEY, "from-env");
  const env2 = {}; assert.deepEqual(setupClaudeAuth({ auth: "login" }, { env: env2, keychain: () => { throw new Error("must not read"); } }), { ok: true, mode: "login" });
  assert.deepEqual(env2, {});
  assert.equal(setupClaudeAuth({ auth: "oauth" }, { env: {} }).code, "BAD_CONFIG");
});
