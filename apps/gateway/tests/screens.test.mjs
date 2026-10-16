import { test } from "node:test";
import assert from "node:assert/strict";
import { render, reduce, needsRebuild, ascii, fitBytes, sessionBody } from "../src/screens.mjs";

const home = {
  counts: { needsYou: 2, working: 1 },
  needsYou: [
    { kind: "approval", provider: "codex", sessionId: "codex:a", title: "Research", requestId: "codex:a:exec-1", text: "Run: touch x" },
    { kind: "question", provider: "claude-code", sessionId: "claude-code:b", title: "Deck Builder", requestId: "claude-code:r2", text: "Target audience?", options: ["CEO", "Technical"] },
  ],
  working: [{ provider: "cowork", sessionId: "cowork:cse_X", title: "WK Agent", status: "working", forSeconds: 125 }],
  recent: Array.from({ length: 30 }, (_, i) => ({ provider: "chatgpt", sessionId: `chatgpt:${i}`, title: `Chat ${i} — “smart” quotes & emoji 🚀`, status: "idle" })),
};
const D = { home, requests: home.needsYou.map((n) => ({ ...n })) };
const D_ = D;
const capture = (pg) => pg.containers.filter((c) => c.isEventCapture === 1).length;

test("every screen respects G2 limits: one capture container, ≤20 items ≤63 bytes, font glyphs only, ≤4 images + ≤8 others", () => {
  const states = [{ screen: "home" }, { screen: "needs" }, { screen: "working" }, { screen: "sessions" }, { screen: "session", sessionId: "cowork:cse_X" }, { screen: "actions", sessionId: "codex:a" }, { screen: "request", requestId: "codex:a:exec-1" }, { screen: "request", requestId: "claude-code:r2" }, { screen: "confirmStop", sessionId: "codex:a" }, { screen: "listening" }, { screen: "voiceConfirm", voice: { transcript: "approve", proposal: { action: "approve", requestId: "codex:a:exec-1", sessionId: "codex:a" } } }, { screen: "voiceConfirm", voice: { transcript: "hmm", proposal: { action: "none", reason: "x" } } }, { screen: "help" }];
  for (const st of states) {
    const pg = render(st, { ...D, session: { provider: "cowork", title: "WK Agent", status: "working", capabilities: { canInterrupt: true } }, latestText: "x".repeat(5000) });
    assert.equal(capture(pg), 1, st.screen);
    assert.ok(pg.containers.filter((c) => c.kind === "image").length <= 4 && pg.containers.filter((c) => c.kind !== "image").length <= 8, st.screen);
    assert.equal(new Set(pg.containers.map((c) => c.containerID)).size, pg.containers.length, `${st.screen} unique ids`);
    for (const c of pg.containers) {
      assert.ok(c.xPosition >= 0 && c.yPosition >= 0 && c.xPosition + c.width <= 576 && c.yPosition + c.height <= 288, `${st.screen} geometry`);
      if (c.kind === "image") assert.ok(c.width >= 20 && c.width <= 288 && c.height >= 20 && c.height <= 144 && /^icons\/[a-z-]+\.png$/.test(c.src), `${st.screen} image`);
      if (c.kind === "list") { assert.ok(c.itemContainer.itemName.length <= 20); for (const n of c.itemContainer.itemName) { assert.ok(Buffer.byteLength(n) <= 63, n); assert.equal(ascii(n), n, `unsupported glyph in ${n}`); } }
      if (c.kind === "text") { assert.ok(c.content.length <= 1000); assert.equal(ascii(c.content), c.content, `unsupported glyph in ${st.screen}`); }
    }
  }
});
test("text filter keeps the font's glyph set (accents, ●▶━) and drops the rest; byte-accurate truncation", () => {
  assert.equal(ascii("“hi” — it’s…"), '"hi" - it\'s...');
  assert.equal(ascii("ok 🚀 ✓"), "ok  ");
  assert.equal(ascii("● ▶ ━ ▁▇ ╭╮ ★ ¿Qué tal, Ñandú?"), "● ▶ ━ ▁▇ ╭╮ ★ ¿Qué tal, Ñandú?");
  assert.ok(Buffer.byteLength(fitBytes("●".repeat(40))) <= 63 && fitBytes("●".repeat(40)).endsWith("..."));
  assert.equal(fitBytes("a".repeat(100)).length, 63);
});
test("navigation: home → needs → approval → Approve emits effect and returns", () => {
  let st = { screen: "home", stack: [] };
  let pg = render(st, D); ({ st } = reduce(st, pg, { event: "click", index: pg.items.findIndex((i) => i.label.startsWith("● Needs you")) })); assert.equal(st.screen, "needs");
  pg = render(st, D); ({ st } = reduce(st, pg, { event: "click", index: 0 })); assert.equal(st.screen, "request"); assert.equal(st.requestId, "codex:a:exec-1");
  pg = render(st, D); assert.deepEqual(pg.items.map((i) => i.label), ["● Approve", "○ Deny", "◁ Back"]);
  assert.ok(pg.containers.some((c) => c.kind === "image" && c.src === "icons/alert.png") && pg.containers.some((c) => c.borderWidth > 0), "alert icon + bordered card");
  const r = reduce(st, pg, { event: "click", index: 0 });
  assert.deepEqual(r.effect, { approve: "codex:a:exec-1" }); assert.equal(r.st.screen, "needs");
});
test("question: options become list items; choosing one answers it", () => {
  const st = { screen: "request", requestId: "claude-code:r2", stack: [{ screen: "needs" }] };
  const pg = render(st, D);
  assert.deepEqual(pg.items.map((i) => i.label), ["A  CEO", "B  Technical", "◁ Back"]);
  assert.deepEqual(reduce(st, pg, { event: "click", index: 1 }).effect, { answer: "Technical", requestId: "claude-code:r2" });
});
test("session: tap → actions → Stop → confirm → Stop now emits stop; hold is push-to-talk (not stop); double-click back; swipe pages", () => {
  const st = { screen: "session", sessionId: "cowork:cse_X", stack: [{ screen: "working" }] };
  const sess = { provider: "cowork", title: "WK", capabilities: { canInterrupt: true } };
  const pg = render(st, { ...D, session: sess, latestText: "abc" });
  assert.equal(reduce(st, pg, { event: "long_press" }).st.screen, "session"); // gateway handles hold as push-to-talk
  const acts = reduce(st, pg, { event: "click" }).st; assert.equal(acts.screen, "actions");
  const apg = render(acts, { ...D, session: sess });
  const conf = reduce(acts, apg, { event: "click", index: apg.items.findIndex((i) => i.label === "■ Stop") }).st; assert.equal(conf.screen, "confirmStop");
  const r = reduce(conf, render(conf, D), { event: "click", index: 0 }); assert.deepEqual(r.effect, { stop: "cowork:cse_X" }); assert.equal(r.st.screen, "actions");
  assert.equal(reduce(st, pg, { event: "double_click" }).st.screen, "working");
  assert.equal(reduce(st, pg, { event: "up" }).st.offset, 1);
});
test("actions screen only offers Stop when the provider can interrupt (no fake parity)", () => {
  const st = { screen: "actions", sessionId: "chatgpt:1" };
  const labels = (caps) => render(st, { ...D, session: { title: "c", capabilities: caps } }).items.map((i) => i.label);
  assert.ok(labels({ canInterrupt: true }).includes("■ Stop")); assert.ok(!labels({ canInterrupt: false }).includes("■ Stop"));
});
test("needsRebuild: text changes → upgrade; list/screen changes → rebuild; session body pages from the end", () => {
  const a = render({ screen: "session", sessionId: "s" }, { ...D, session: { title: "t" }, latestText: "one" });
  const b = render({ screen: "session", sessionId: "s" }, { ...D, session: { title: "t" }, latestText: "two" });
  assert.equal(needsRebuild(a, b), false);
  assert.equal(needsRebuild(render({ screen: "home" }, D), render({ screen: "home" }, { home: { ...home, counts: { needsYou: 3, working: 1 } } })), true);
  assert.ok(sessionBody("A".repeat(1000) + "END").endsWith("END"));
  assert.ok(sessionBody("A".repeat(1000) + "END", 1).startsWith("..."));
});

test("home = command center: 3 most recent sessions across harnesses (marked), then lists and speech toggle", () => {
  const live = { "cowork:cse_X": { status: "working", at: "2026-10-09T02:00:00Z" } };
  const pg = render({ screen: "home" }, { ...D, live, speech: false });
  const labels = pg.items.map((i) => i.label);
  assert.equal(labels.length, 7); // no allSessions in this fixture → no per-harness rows
  assert.ok(labels.slice(0, 3).every((l) => /^[●▶○■▲] (Codex|Claude|Cowork|ChatGPT)  /.test(l)), labels.join(" | "));
  assert.ok(labels.includes("● Codex  Research") && labels.some((l) => l.startsWith("▶ Cowork  WK Agent")));
  assert.deepEqual(labels.slice(3), ["● Needs you  2", "▶ Working  1", "▷ All sessions", "○ Speech off"]);
  assert.deepEqual(reduce({ screen: "home" }, pg, { event: "click", index: 6 }).effect, { speech: true });
});

test("steps: latest turn's tool calls / commands / Cowork step groups; tap opens detail; swipe pages it", async () => {
  const { stepsFrom } = await import("../src/screens.mjs");
  const codex = { title: "X", messages: [{ role: "user", text: "go" }, { role: "tool", tool: { name: "commandExecution", input: { command: "/bin/zsh -lc 'touch a.txt'", cwd: "/w" } }, toolResult: { status: "completed", exitCode: 0, preview: "" } }, { role: "assistant", text: "done" }] };
  assert.deepEqual(stepsFrom(codex).map((x) => x.label), ["Ran: touch a.txt"]);
  const cc = { messages: [{ role: "user", text: "w" }, { role: "assistant", tool: { name: "Write", input: { file_path: "/a/b/c.txt", content: "hi" } } }] };
  assert.equal(stepsFrom(cc)[0].label, "Write: c.txt"); assert.match(stepsFrom(cc)[0].detail, /content: hi/);
  const cw = { messages: [{ role: "user", text: "q" }, { role: "assistant", text: "a", tools: ["Reading files.", "Used 9 tools, ran 3 commands"] }, { role: "user", text: "next" }] };
  assert.deepEqual(stepsFrom(cw).map((x) => x.label), ["Reading files.", "Used 9 tools, ran 3 commands"]); // latest turn with steps
  const st = { screen: "actions", sessionId: "codex:a", stack: [] };
  const pg = render(st, { ...D, session: { ...codex, capabilities: {} } });
  const steps = reduce(st, pg, { event: "click", index: pg.items.findIndex((i) => i.label === "▷ Steps  1") }).st; assert.equal(steps.screen, "steps");
  const sp = render(steps, { ...D, session: codex }); const one = reduce(steps, sp, { event: "click", index: 0 }).st;
  assert.deepEqual([one.screen, one.index], ["step", 0]);
  assert.match(render(one, { ...D, session: codex }).containers.find((c) => c.containerName === "body").content, /Command: touch a.txt/);
  assert.equal(reduce(one, null, { event: "down" }).st.offset, 1);
});

test("harness list pages through ALL sessions (More / Previous), within the 20-item limit", () => {
  const D = { ...D_, home: { ...D_.home, needsYou: [], working: [], recent: [] } };   // only the full list
  const all = Array.from({ length: 40 }, (_, i) => ({ sessionId: `cowork:s${i}`, provider: "cowork", title: `Task ${i}` }));
  let st = { screen: "sessions", provider: "cowork", stack: [{ screen: "home" }] };
  const p1 = render(st, { ...D, allSessions: all }); const l1 = p1.items.map((i) => i.label);
  assert.ok(l1.length <= 20); assert.match(l1.at(-2), /^▼ More  2[0-9]$/); assert.equal(l1.at(-1), "◁ Back");
  st = reduce(st, p1, { event: "click", index: l1.length - 2 }).st; assert.equal(st.page, 1);
  const p2 = render(st, { ...D, allSessions: all }); assert.equal(p2.items[0].label, "○ Task 18"); assert.equal(p2.items.at(-1).label, "▲ Previous");
});

test("home lists every harness with its count; All sessions pages the full list", () => {
  const D = { ...D_, home: { ...D_.home, needsYou: [], working: [], recent: [] } };   // only the full list
  const all = [...Array.from({ length: 30 }, (_, i) => ({ sessionId: `cowork:c${i}`, provider: "cowork", title: `C${i}` })), { sessionId: "codex:x", provider: "codex", title: "X" }];
  const pg = render({ screen: "home" }, { ...D, allSessions: all });
  const labels = pg.items.map((i) => i.label);
  assert.ok(labels.includes("▷ Cowork  30") && labels.includes("▷ Codex  1") && labels.includes("▷ All sessions  31"), labels.join(" | "));
  const st = reduce({ screen: "home", stack: [] }, pg, { event: "click", index: labels.indexOf("▷ Cowork  30") }).st;
  assert.deepEqual([st.screen, st.provider], ["sessions", "cowork"]);
  const allPg = render({ screen: "sessions", stack: [] }, { ...D, allSessions: all });
  assert.match(allPg.containers[0].content, /^ALL SESSIONS  3\d    1\/2$/); assert.ok(allPg.items.length <= 20); assert.match(allPg.items.at(-2).label, /^▼ More/);
});

test("harness-reported status: Running → Working, Awaiting input → Needs you, unread → ★", async () => {
  const { buildHome } = await import("../src/viewModel.mjs");
  const sessions = [
    { sessionId: "cowork:chat:a", provider: "cowork", title: "Cloud workspace", status: "working" },
    { sessionId: "cowork:chat:b", provider: "cowork", title: "Podcast dubbing", status: "waiting_for_input" },
    { sessionId: "cowork:chat:c", provider: "cowork", title: "Literacy preview", status: "complete" },
  ];
  const h = buildHome({ sessions, attention: [] });
  assert.equal(h.counts.working, 1); assert.equal(h.counts.needsYou, 1);
  assert.equal(h.needsYou[0].kind, "input");
  const needs = render({ screen: "needs" }, { home: h, requests: [] }).items.map((i) => i.label);
  assert.ok(needs.includes("● Cowork  waiting: Podcast dubbing"), needs.join(" | "));
  const homeLabels = render({ screen: "home" }, { home: h, requests: [], allSessions: sessions }).items.map((i) => i.label);
  assert.ok(homeLabels.some((l) => l.startsWith("★ Cowork  Literacy preview")), homeLabels.join(" | "));
});

test("speech switch: visible in home header when muted, toggle row in the session menu", () => {
  assert.match(render({ screen: "home" }, { ...D, speech: false }).containers[0].content, /○ muted$/);
  assert.doesNotMatch(render({ screen: "home" }, { ...D, speech: true }).containers[0].content, /muted/);
  const st = { screen: "actions", sessionId: "codex:a" };
  const pg = render(st, { ...D, speech: true, session: { title: "t", capabilities: {} } });
  const i = pg.items.findIndex((x) => x.label.startsWith("● Speech on"));
  assert.ok(i >= 0); assert.deepEqual(reduce(st, pg, { event: "click", index: i }).effect, { speech: false });
});

test("system check: home gets one warning row only when something fails; the check screen lists every part", async () => {
  const { render } = await import("../src/screens.mjs");
  const base = { home: { counts: { needsYou: 0, working: 0 }, needsYou: [], working: [], recent: [] }, allSessions: [] };
  const ok = [{ id: "chrome", ok: true, label: "Chrome extension 0.4.0" }, { id: "voice", ok: true, label: "Voice service running" }];
  const bad = [ok[0], { id: "cowork", ok: false, label: "Cowork: signed out of claude.ai" }, { id: "voice", ok: false, label: "Voice service down: no speech" }];
  const labels = (pg) => pg.items.map((i) => i.label);
  assert.ok(!labels(render({ screen: "home" }, { ...base, health: ok })).some((l) => /signed out|down/.test(l)));
  const home = render({ screen: "home" }, { ...base, health: bad });
  assert.match(home.items[0].label, /Cowork: signed out of claude\.ai  \+1$/); assert.deepEqual(home.items[0].action, { go: "health" });
  const chk = render({ screen: "health" }, { ...base, health: bad });
  assert.deepEqual(labels(chk).slice(0, 3).map((l) => l.slice(2)), bad.map((x) => x.label));
  assert.match(JSON.stringify(chk), /2 problems/);
  assert.match(JSON.stringify(render({ screen: "health" }, { ...base, health: ok })), /all good/);
});

test("a harness list includes its recent sessions (they are also in the home summary)", async () => {
  const { render } = await import("../src/screens.mjs");
  const rows = [{ sessionId: "cowork:cse_a", provider: "cowork", title: "Board deck" }, { sessionId: "cowork:cse_b", provider: "cowork", title: "Memo" }, { sessionId: "codex:x", provider: "codex", title: "Migrate" }];
  const d = { home: { counts: { needsYou: 0, working: 0 }, needsYou: [], working: [], recent: rows }, allSessions: rows };
  const pg = render({ screen: "sessions", provider: "cowork" }, d);
  assert.deepEqual(pg.items.filter((i) => i.action.go === "session").map((i) => i.action.sessionId), ["cowork:cse_a", "cowork:cse_b"]);
  assert.match(JSON.stringify(pg), /COWORK  2/);
});
