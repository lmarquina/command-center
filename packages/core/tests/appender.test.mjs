import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appender } from "../src/appender.mjs";

test("a log past its size cap moves to .1 and starts again; only one old file is kept", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-log-")), "a.log");
  const write = appender(f, { maxBytes: 1000, checkEvery: 10 });
  for (let i = 0; i < 300; i++) write("x".repeat(49));
  assert.ok(fs.statSync(f).size <= 1000 + 10 * 50, `live file ${fs.statSync(f).size} bytes`);
  assert.ok(fs.existsSync(`${f}.1`)); assert.ok(!fs.existsSync(`${f}.2`));
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});
