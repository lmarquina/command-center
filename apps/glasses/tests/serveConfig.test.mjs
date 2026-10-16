import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serveConfig } from "../serveConfig.mjs";

const config = { gateway: { glasses: { port: 3100, appPort: 5173 } } };

test("without a certificate the app is served over plain http on the local network", () => {
  const s = serveConfig({ config, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), "cc-tls-")) });
  assert.deepEqual([s.scheme, s.host, s.port, s.server.host, s.server.https], ["http", null, 5173, "0.0.0.0", undefined]);
});

test("with a certificate it is served over https at the certificate's name; the simulator mode stays local and plain", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=mac.example.ts.net", "-keyout", path.join(dir, "ts.key"), "-out", path.join(dir, "ts.crt")], { stdio: "ignore" });
  const s = serveConfig({ config, tlsDir: dir });
  assert.deepEqual([s.scheme, s.host, s.server.allowedHosts, s.server.hmr.protocol], ["https", "mac.example.ts.net", ["mac.example.ts.net"], "wss"]);
  const sim = serveConfig({ config, tlsDir: dir, plain: true });
  assert.deepEqual([sim.scheme, sim.port, sim.server.host, sim.server.https], ["http", 5174, "127.0.0.1", undefined]);
});
