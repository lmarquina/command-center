// Integration test: start the native host as Chrome would (framed stdin/stdout), talk to it as the daemon would
// (Unix socket), and check requests, replies and events cross correctly. Also checks the install script.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
let pass = 0, fail = 0;
const ok = (v, m) => { if (!v) throw new Error(m); };
async function t(name, fn) { try { await fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } }

const run = fs.mkdtempSync(path.join(os.tmpdir(), "cc-host-"));
const host = spawn(process.execPath, [path.join(HERE, "../native-host/host.mjs")], { env: { ...process.env, CC_RUN_DIR: run }, stdio: ["pipe", "pipe", "inherit"] });
const frames = []; let out = Buffer.alloc(0); const waiters = [];
host.stdout.on("data", (d) => {
  out = Buffer.concat([out, d]);
  while (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) { const n = out.readUInt32LE(0); frames.push(JSON.parse(out.subarray(4, 4 + n))); out = out.subarray(4 + n); }
  for (const w of waiters.splice(0)) w();
});
const frame = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); host.stdin.write(Buffer.concat([h, b])); };
const until = async (list, pred, wake) => { for (let i = 0; i < 200; i++) { const m = list.find(pred); if (m) return m; await new Promise((r) => { wake.push(r); setTimeout(r, 25); }); } throw new Error("timed out waiting"); };
const sock = path.join(run, "bridge.sock");
for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 20));

const lines = [], lw = []; let buf = "";
const c = net.createConnection(sock);
c.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } for (const w of lw.splice(0)) w(); });
const call = (id, method, params) => { c.write(JSON.stringify({ id, method, params }) + "\n"); return until(lines, (m) => m.id === id, lw); };

await t("socket is private to the user (0600)", () => ok((fs.statSync(sock).mode & 0o777) === 0o600, "mode"));
await t("hello handshake is answered and shows up in host.ping", async () => {
  frame({ type: "hello", version: "0.3.0" });
  await until(frames, (f) => f.type === "hello" && f.from === "host", waiters);
  const r = await call("1", "host.ping"); ok(r.ok && r.result.extension.version === "0.3.0", JSON.stringify(r));
});
await t("a client request reaches the extension and its reply returns under the client's id", async () => {
  const p = call("2", "session.list", { provider: "cowork" });
  const f = await until(frames, (x) => x.method === "session.list", waiters);
  ok(f.params.provider === "cowork" && f.id !== "2", JSON.stringify(f));
  frame({ id: f.id, ok: true, result: { sessions: [{ sessionId: "cowork:cse_x", kind: "cowork", title: "T" }] } });
  const r = await p; ok(r.ok && r.id === "2" && r.result.sessions.length === 1, JSON.stringify(r));
});
await t("events go only to subscribers", async () => {
  await call("3", "events.subscribe");
  frame({ type: "event", event: "session.listChanged", sessionId: "cowork:cse_x" });
  const e = await until(lines, (m) => m.type === "event", lw); ok(e.event === "session.listChanged", JSON.stringify(e));
});
await t("closing stdin (Chrome quit / extension reload) stops the host and removes the socket", async () => {
  host.stdin.end(); await new Promise((r) => host.on("exit", r)); ok(!fs.existsSync(sock), "socket left behind");
});
await t("install script writes a manifest that allows only the given extension, and rejects a bad id", () => {
  const nm = fs.mkdtempSync(path.join(os.tmpdir(), "cc-nm-")), id = "abcdefghijklmnopabcdefghijklmnop";
  execFileSync("sh", [path.join(HERE, "../install.sh"), id], { env: { ...process.env, CC_NM_DIR: nm } });
  const m = JSON.parse(fs.readFileSync(path.join(nm, "com.commandcenter.bridge.json"), "utf8"));
  ok(m.name === "com.commandcenter.bridge" && m.allowed_origins.length === 1 && m.allowed_origins[0] === `chrome-extension://${id}/` && fs.existsSync(m.path), JSON.stringify(m));
  let threw = false; try { execFileSync("sh", [path.join(HERE, "../install.sh"), "nope"], { env: { ...process.env, CC_NM_DIR: nm }, stdio: "pipe" }); } catch { threw = true; }
  ok(threw, "bad id accepted");
});
c.destroy();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
