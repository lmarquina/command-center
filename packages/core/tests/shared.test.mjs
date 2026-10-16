import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { SessionLock } from "../src/sessionLock.mjs";
import { Deduper } from "../src/dedupe.mjs";

const SID = "11111111-2222-3333-4444-555555555555";

test("SessionLock: exclusive across owners, re-entrant for holder, stale lock taken over", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cclock-"));
  const a = new SessionLock(dir, "A"), b = new SessionLock(dir, "B");
  a.acquire(SID); a.acquire(SID); // re-entrant
  // B in the same pid but different owner: simulate a live foreign holder by writing a lock with a live pid of another process
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"]);
  a.release(SID);
  fs.writeFileSync(path.join(dir, `${SID}.lock`), JSON.stringify({ sessionId: SID, owner: "other", pid: child.pid, acquiredAt: "t" }));
  assert.throws(() => b.acquire(SID), { code: "SESSION_LOCKED" });
  child.kill("SIGKILL"); await new Promise((r) => child.on("exit", r));
  assert.equal(b.acquire(SID).owner, "B"); // stale → taken over
  assert.throws(() => b.file("../etc/passwd"), { code: "BAD_SESSION_ID" });
});

test("deduper: an id is new once, and the window is bounded", () => {
  const d = new Deduper(2);
  assert.deepEqual([d.firstTime("x"), d.firstTime("x"), d.firstTime("y"), d.firstTime("z"), d.firstTime("x")], [true, false, true, true, true]);
});
