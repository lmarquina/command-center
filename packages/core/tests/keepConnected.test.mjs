import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { keepConnected } from "../src/keepConnected.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("while the other side is down there is only ever one attempt in flight; one connection once it is back", async () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-kc-")), "s.sock");
  const realConnect = net.createConnection; let attempts = 0;
  net.createConnection = (...a) => { attempts++; return realConnect(...a); };
  try {
    const got = [], downs = [];
    const k = keepConnected({ path: p, retryMs: 10, onMessage: (m) => got.push(m.n), onDown: () => downs.push(1), onConnect: (s) => s.write("hi\n") });
    await wait(200);
    assert.ok(attempts <= 21, `attempts grew to ${attempts} in 200 ms (expected about 1 per 10 ms)`);
    let conns = 0; const socks = new Set();
    const srv = net.createServer((s) => { conns++; socks.add(s); s.on("error", () => {}); s.on("close", () => socks.delete(s)); s.on("data", () => s.write(JSON.stringify({ n: conns }) + "\nnot json\n")); }).listen(p);
    await wait(80);
    assert.deepEqual([conns, got, k.connected], [1, [1], true]);
    for (const s of socks) s.destroy();
    await wait(80);
    assert.deepEqual([conns, got, downs.length], [2, [1, 2], 1]);
    k.close(); await wait(50); assert.equal(conns, 2); srv.close();
  } finally { net.createConnection = realConnect; }
});
