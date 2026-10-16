import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

// ---------- security (real server process, no agentd) ----------
function req(port, p, { host, headers = {}, method = "GET" } = {}) {
  return new Promise((res) => { const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: host || `127.0.0.1:${port}`, ...headers } }, (x) => { let b = ""; x.on("data", (d) => (b += d)); x.on("end", () => res({ status: x.statusCode, headers: x.headers, body: b })); }); r.end(); });
}
test("gateway security: host check, token on API + SSE, token injected only in our page, CSP", async () => {
  const port = 3900 + Math.floor(Math.random() * 90);
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gw-"));
  const p = spawn(process.execPath, [path.join(ROOT, "src/server.mjs")], { env: { ...process.env, CC_PORT: String(port), CC_RUN_DIR: run, AGENTD_SOCK: path.join(run, "absent.sock"), CC_GLASSES: "0" } });
  await new Promise((r) => p.stderr.once("data", r));
  const token = fs.readFileSync(path.join(run, "token"), "utf8").trim();
  assert.equal(fs.statSync(path.join(run, "token")).mode & 0o777, 0o600);
  try {
    assert.equal((await req(port, "/", { host: "evil.example:80" })).status, 421);                       // DNS rebinding
    assert.equal((await req(port, "/api/home")).status, 401);                                               // no token
    assert.equal((await req(port, "/api/home", { headers: { "X-CC-Token": "nope" } })).status, 401);
    assert.equal((await req(port, "/api/events?token=nope")).status, 401);
    const down = await req(port, "/api/home", { headers: { "X-CC-Token": token } });
    assert.equal(down.status, 503); assert.match(down.body, /AGENTD_DOWN/);                                  // authed, agentd absent
    const page = await req(port, "/");
    assert.ok(page.body.includes(token) && !page.body.includes("__CC_TOKEN__"));
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(page.headers["access-control-allow-origin"], undefined);                                   // never CORS
    assert.equal((await req(port, "/../run/token")).status, 404);                                           // no traversal
  } finally { p.kill(); }
});
