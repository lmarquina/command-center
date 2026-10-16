import { test } from "node:test";
import assert from "node:assert/strict";
import { Presentation } from "../src/presentation.mjs";

const p = new Presentation({ enabled: true, cwdPrefixes: ["/demo"], titles: ["^Trip ideas"] });

test("demo sessions show in clear; everything else keeps its place but its title is masked", () => {
  assert.equal(p.row({ sessionId: "codex:a", title: "Migrate API", cwd: "/demo/acme" }).title, "Migrate API");
  assert.equal(p.row({ sessionId: "chatgpt:b", title: "Trip ideas for Lisbon" }).title, "Trip ideas for Lisbon");
  const m = p.row({ sessionId: "cowork:cse_x", title: "Northwind build plan", project: "Client X", cwd: "/Users/me/clients" });
  assert.equal(m.masked, true); assert.doesNotMatch(m.title + m.project, /Northwind|Client|build|plan/); assert.match(m.title, /^█+ █+ █+$/);
  assert.equal(m.cwd, undefined);
  assert.equal(p.row({ sessionId: "codex:c", title: "x", cwd: "/demolition" }).masked, true);   // prefix means folder, not string
});

test("sessions created during the demo show; masked sessions' events and requests carry no text", () => {
  p.created.add("cowork:cse_new");
  assert.equal(p.row({ sessionId: "cowork:cse_new", title: "Board talking points" }).title, "Board talking points");
  const e = p.event({ type: "agent.output.complete", text: "Revenue for Client X is", request: { description: "Run deploy" } }, { sessionId: "codex:z", title: "secret" });
  assert.doesNotMatch(JSON.stringify(e), /Revenue|Client|deploy/);
  assert.equal(p.item({ text: "Approve sending the Northwind email" }, { sessionId: "codex:z", title: "secret" }).text.includes("Northwind"), false);
  assert.equal(new Presentation({ enabled: false }).row({ title: "anything" }).title, "anything");
});

test("through the core: lists, attention, opened sessions and events are masked; demo ones are not", async () => {
  const { SessionCore } = await import("../src/SessionCore.mjs");
  const listeners = new Set();
  const prov = {
    onEvent: (cb) => listeners.add(cb), start: async () => ({}), stop: async () => {},
    list: async () => [{ nativeId: "11111111-1111-4111-8111-111111111111", title: "Northwind build", cwd: "/work/x" }, { nativeId: "22222222-2222-4222-8222-222222222222", title: "Refactor auth", cwd: "/demo/acme" }],
    get: async (n) => ({ title: n.startsWith("1") ? "Northwind build" : "Refactor auth", messages: [{ role: "assistant", text: "Northwind wants pricing" }] }),
  };
  const core = new SessionCore({ providers: { codex: prov }, presentation: { enabled: true, cwdPrefixes: ["/demo"] } });
  const { sessions } = await core.listSessions();
  assert.deepEqual(sessions.map((s) => [s.title === "Refactor auth", !!s.masked]), [[false, true], [true, false]]);
  const opened = await core.getSession("codex:11111111-1111-4111-8111-111111111111");
  assert.doesNotMatch(JSON.stringify(opened), /Northwind|pricing/);
  const seen = []; core.on("event", (e) => seen.push(e));
  for (const l of listeners) l({ id: "e1", type: "approval.requested", provider: "codex", sessionId: "codex:11111111-1111-4111-8111-111111111111", request: { requestId: "codex:r1", description: "Email Northwind the quote" } });
  assert.doesNotMatch(JSON.stringify(seen) + JSON.stringify(core.needsAttention()), /Northwind|quote/);
});

test("an ids file lists exactly the sessions to show, and is re-read when it changes", async () => {
  const { default: fs } = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-ids-")), "ids.json");
  fs.writeFileSync(f, JSON.stringify({ a: "codex:one" }));
  const q = new Presentation({ enabled: true, idsFile: f });
  assert.deepEqual([q.shows({ sessionId: "codex:one" }), q.shows({ sessionId: "codex:two" })], [true, false]);
  await new Promise((r) => setTimeout(r, 20)); fs.writeFileSync(f, JSON.stringify({ a: "codex:two" })); fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual([q.shows({ sessionId: "codex:one" }), q.shows({ sessionId: "codex:two" })], [false, true]);
});
