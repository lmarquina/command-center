import { test } from "node:test";
import assert from "node:assert/strict";
import { findLeaks, rulesFor } from "../src/scan.mjs";

// Examples are assembled from pieces so this file itself passes the publish scan.

const scan = (text, terms = ["Acme Corp", "zz-session-1234"]) => findLeaks([{ path: "f.md", text }], rulesFor(terms)).map((h) => h.rule);

test("blocks the owner's terms as whole words, any case, but not inside other words", () => {
  assert.deepEqual(scan("Prep the ACME corp agenda"), ["personal term"]);
  assert.deepEqual(scan("thread zz-session-1234 failed"), ["personal term"]);
  assert.deepEqual(scan("Acme Corporation is fine? no: 'Acme Corporation' contains the term"), []);
});

test("blocks generic personal data: hostnames, private addresses, emails, home paths, keys", () => {
  assert.deepEqual(scan(`wss://mac.tail1a2b3c${".ts"}.net:3100`), ["Tailscale hostname"]);
  assert.deepEqual(scan(`phone at ${[100, 87, 37, 25].join(".")}`), ["Tailscale/CGNAT address"]);
  assert.deepEqual(scan(`http://${[192, 168, 1, 6].join(".")}:5173`), ["LAN address"]);
  assert.deepEqual(scan(`contact jane.doe${"@"}gmail.com`), ["email address"]);
  assert.deepEqual(scan(`path: "/${"Users"}/jane/Documents"`), ["home directory path"]);
  assert.deepEqual(scan(`-----BEGIN EC ${"PRIVATE"} KEY-----`), ["private key"]);
  assert.deepEqual(scan(`key sk${"-"}abcdefghijklmnopqrstuvwxyz123`), ["API key"]);
});

test("lockfile version numbers are not addresses, but a lockfile still cannot carry personal terms", () => {
  const files = [{ path: "services/voice/uv.lock", text: `version = "${[10, 4, 0, 35].join(".")}"\nAcme Corp` }];
  assert.deepEqual(findLeaks(files, rulesFor(["Acme Corp"])).map((h) => [h.line, h.rule]), [[2, "personal term"]]);
});

test("leaves placeholders and attribution alone, and reports file and line without repeating the match", () => {
  assert.deepEqual(scan("Co-Authored-By: Claude <noreply@anthropic.com>\nmailto:command-center@localhost\n/Users/me/Documents\n127.0.0.1 and 8.8.8.8"), []);
  assert.deepEqual(findLeaks([{ path: "a/b.js", text: "ok\nAcme Corp" }], rulesFor(["Acme Corp"])), [{ path: "a/b.js", line: 2, rule: "personal term" }]);
});

test("every match on a line is checked, not just the first (an allowed placeholder can't hide a real value)", () => {
  assert.deepEqual(scan(`a${"@"}example.com and b${"@"}gmail.com`), ["email address"]);
  assert.deepEqual(scan(`/${"Users"}/me/x and /${"Users"}/bob/y`), ["home directory path"]);
});

test("also catches: any .ts.net name, 172.16-31 addresses, a home path without a trailing slash", () => {
  assert.deepEqual(scan(`wss://mac.happy-otter${".ts"}.net:3100`), ["Tailscale hostname"]);
  assert.deepEqual(scan(`at ${[172, 20, 1, 4].join(".")}`), ["LAN address"]);
  assert.deepEqual(scan(`PATH=/${"Users"}/bob`), ["home directory path"]);
  assert.deepEqual(scan(`${[172, 15, 1, 4].join(".")} is public`), []);
});

test("file names are scanned like file contents", async () => {
  const { findLeaks } = await import("../src/scan.mjs");
  assert.deepEqual(findLeaks([{ path: "notes/acme corp plan.md", text: "" }], rulesFor(["Acme Corp"])).map((h) => [h.line, h.rule]), [[0, "personal term (file name)"]]);
});

test("the reserved example name is allowed; a real-looking one next to it is not", () => {
  assert.deepEqual(scan(`mac.example${".ts"}.net`), []);
  assert.deepEqual(scan(`mac.example${".ts"}.net and mac.otter-bay${".ts"}.net`), ["Tailscale hostname"]);
});

test("an allowed email domain must be the whole domain", () => {
  assert.deepEqual(scan(`x${"@"}localhost.evil.com`), ["email address"]);
  assert.deepEqual(scan(`noreply${"@"}anthropic.com`), []);
});
