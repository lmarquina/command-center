import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchAgentPlist } from "../src/cli.mjs";

test("login item: valid plist that always restarts the supervisor", () => {
  const xml = launchAgentPlist({ node: "/r/node", cli: "/r/cli.mjs", root: "/r & co", logs: "/r/run/logs", path: "/opt/homebrew/bin:/usr/bin" });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-plist-")), "a.plist"); fs.writeFileSync(f, xml);
  const j = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f], { encoding: "utf8" }));
  assert.deepEqual(j.ProgramArguments, ["/r/node", "/r/cli.mjs", "up", "--foreground"]);
  assert.equal(j.KeepAlive, true);   // always restarted; npm run stop unloads it instead
  assert.equal(j.ProcessType, "Interactive");   // otherwise macOS defers the restart as "inefficient"
  assert.equal(j.RunAtLoad, true); assert.equal(j.WorkingDirectory, "/r & co");
  assert.match(j.EnvironmentVariables.PATH, /homebrew/);
});
