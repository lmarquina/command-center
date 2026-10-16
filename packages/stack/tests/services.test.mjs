import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConfig } from "@command-center/core/config.mjs";
import { REPO_ROOT } from "@command-center/core/paths.mjs";
import { serviceSpecs, simSpecs } from "../src/services.mjs";

test("the checked-in config starts every service, in dependency order, from files that exist", () => {
  const specs = serviceSpecs({ config: loadConfig(), root: REPO_ROOT });
  assert.deepEqual(specs.map((s) => s.name), ["agentd", "gateway", "glasses", "voice", "awake"]);
  for (const s of specs.filter((x) => x.name !== "awake")) assert.ok(fs.existsSync(s.args[0]), `${s.name}: ${s.args[0]}`);
});

test("services can be switched off in the config; a typo is an error, not a silent skip", () => {
  const base = { gateway: { glasses: { appPort: 5173 } }, voice: { modelsDir: "/models" } };
  const specs = serviceSpecs({ config: { ...base, stack: { services: ["agentd", "voice"], keepAwake: false } }, root: "/r", node: "node" });
  assert.deepEqual(specs.map((s) => [s.name, s.cmd]), [["agentd", "node"], ["voice", "/bin/sh"]]);
  assert.deepEqual(specs[1].env, { CC_VOICE_MODELS: "/models" });
  assert.throws(() => serviceSpecs({ config: { ...base, stack: { services: ["agentd", "gatewy"] } }, root: "/r" }), { code: "BAD_CONFIG" });
});

test("the simulator loads the local-only copy of the app and gets an automation port", () => {
  const [app, sim] = simSpecs({ config: { gateway: { glasses: { appPort: 5173 } }, stack: { simAutomationPort: 9898 } }, root: "/r", token: "tok", node: "node" });
  assert.deepEqual(app.env, { CC_PLAIN: "1" });
  assert.deepEqual(sim.args.slice(1), ["--automation-port", "9898", "http://127.0.0.1:5174/#t=tok"]);
});
