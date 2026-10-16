import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Supervisor } from "../src/supervisor.mjs";

const node = process.execPath, wait = (ms) => new Promise((r) => setTimeout(r, ms));
const forever = { cmd: node, args: ["-e", "setInterval(()=>{},1000)"] };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a service that exits is restarted, with a delay that doubles while it keeps failing", async () => {
  const delays = [];
  const s = new Supervisor({ services: [{ name: "crashy", cmd: node, args: ["-e", "process.exit(3)"] }], minDelayMs: 20, maxDelayMs: 100, stableMs: 5000 });
  s.on("restarting", (e) => delays.push(e.inMs)); s.start();
  await wait(700); await s.stop();
  assert.deepEqual(delays.slice(0, 4), [20, 40, 80, 100]);
  const n = delays.length; await wait(250); assert.equal(delays.length, n, "nothing restarts after stop()");
});

test("a service that ran long enough restarts quickly again; a command that cannot start is retried, not fatal", async () => {
  const delays = [];
  const s = new Supervisor({ services: [{ name: "ok-then-dies", cmd: node, args: ["-e", "setTimeout(()=>process.exit(1),120)"] }, { name: "missing", cmd: "/nonexistent/binary" }], minDelayMs: 20, maxDelayMs: 2000, stableMs: 100 });
  s.on("restarting", (e) => delays.push([e.name, e.inMs])); s.start();
  await wait(500); await s.stop();
  assert.deepEqual([...new Set(delays.filter((d) => d[0] === "ok-then-dies").map((d) => d[1]))], [20]);
  assert.ok(delays.filter((d) => d[0] === "missing").length >= 2);
});

test("stop ends every service (killing one that ignores the request) and output lands in per-service logs", async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sup-"));
  const s = new Supervisor({ logDir, killAfterMs: 200, services: [
    { name: "talker", cmd: node, args: ["-e", "console.log('hello from talker'); setInterval(()=>{},1000)"] },
    { name: "stubborn", cmd: node, args: ["-e", "process.on('SIGTERM',()=>{}); console.log('up'); setInterval(()=>{},1000)"] },
    { name: "plain", ...forever },
  ] }).start();
  await wait(400);
  const pids = s.status().map((x) => x.pid); assert.ok(pids.every(alive));
  await s.stop();
  assert.deepEqual(pids.map(alive), [false, false, false]);
  assert.match(fs.readFileSync(path.join(logDir, "talker.log"), "utf8"), /hello from talker/);
  assert.equal(fs.statSync(path.join(logDir, "talker.log")).mode & 0o777, 0o600);
});

test("stopping a service also stops the processes it started", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-sup-")), pidFile = path.join(dir, "grandchild.pid");
  const script = `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const s = new Supervisor({ services: [{ name: "launcher", cmd: node, args: ["-e", script] }], killAfterMs: 300 }).start();
  for (let i = 0; i < 40 && !fs.existsSync(pidFile); i++) await wait(50);
  const grandchild = Number(fs.readFileSync(pidFile, "utf8")); assert.ok(alive(grandchild));
  await s.stop(); await wait(100);
  assert.equal(alive(grandchild), false, "grandchild left running");
});

