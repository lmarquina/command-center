import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVoice, matchOption, titleSim } from "../src/voiceCommands.mjs";
import { phon, phraseSim } from "../src/fuzzy.mjs";

const appr = { requestId: "codex:a:exec-1", sessionId: "codex:a", kind: "approval", text: "Run: touch x" };
const q = { requestId: "claude-code:r2", sessionId: "claude-code:b", kind: "question", text: "Which file?", options: ["option-a.txt", "option-b.txt"] };
const projects = ["Weekly Newsletter", "Hartwell Kramer", "Garden Planner"];
const sessions = [
  { sessionId: "codex:a", provider: "codex", title: "Research repo" },
  { sessionId: "claude-code:b", provider: "claude-code", title: "Deck builder" },
  { sessionId: "cowork:chat:c", provider: "cowork", title: "Hartwell Kramer agenda" },
  { sessionId: "chatgpt:d", provider: "chatgpt", title: "Kitchen remodel ideas" },
];
const home = { screen: "home" };

test("fuzzy primitives: sound-alikes match", () => {
  assert.equal(phon("codecs"), phon("codex")); assert.equal(phon("cramer"), phon("kramer"));
  assert.ok(phraseSim("a prove", "approve") > 0.9); assert.ok(titleSim("the deck one", "Deck builder") > 0.9);
});
test("approve/deny: misheard and casual forms; scope rules; ambiguity refuses", () => {
  for (const t of ["Approve.", "Approves.", "a prove", "yes, go ahead", "yep", "do it"]) assert.equal(parseVoice(t, { screen: "request", requestId: appr.requestId }, { requests: [appr, q] }).action, "approve", t);
  for (const t of ["Deny that.", "nope", "Denies.", "don't"]) assert.equal(parseVoice(t, home, { requests: [appr] }).action, "deny", t);
  assert.equal(parseVoice("approve", home, { requests: [appr, { ...appr, requestId: "x", sessionId: "codex:z" }] }).action, "none");
  assert.equal(parseVoice("approve", home, { requests: [] }).action, "none");
});
test("questions: fuzzy option text, letters (incl. 'bee'), ordinals; approve on a question refuses", () => {
  const st = { screen: "request", requestId: q.requestId };
  for (const t of ["option B", "Option bee.", "the second one", "option b dot txt", "B"]) assert.equal(parseVoice(t, st, { requests: [q] }).answer, "option-b.txt", t);
  assert.equal(parseVoice("approve", st, { requests: [q] }).action, "none");
  assert.equal(matchOption("technical", ["CEO", "Technical audience"]), "Technical audience");
  assert.equal(matchOption("the technical audience please", ["CEO overview", "Technical audience"]), "Technical audience");
});
test("navigation runs from anywhere outside a session, tolerant of phrasing", () => {
  for (const [t, to] of [["needs you", "needs"], ["what needs me?", "needs"], ["what's waiting", "needs"], ["what's running", "working"], ["go home", "home"], ["back", "back"], ["all sessions", "sessions"]])
    assert.deepEqual([parseVoice(t, home, { sessions }).action, parseVoice(t, home, { sessions }).to], ["nav", to], t);
  assert.equal(parseVoice("next one", home, { sessions }).action, "next");
  assert.equal(parseVoice("be quiet", home, {}).action, "speech");
});
test("harness name (sound-alikes) → that harness's session list; title words → the session", () => {
  assert.deepEqual([parseVoice("go to codecs", home, { sessions }).to, parseVoice("go to codecs", home, { sessions }).provider], ["sessions", "codex"]);
  assert.equal(parseVoice("switch to cow work", home, { sessions }).provider, "cowork");
  assert.equal(parseVoice("open the deck one", home, { sessions }).sessionId, "claude-code:b");
  assert.equal(parseVoice("show me the Heartwell Cramer agenda", home, { sessions }).sessionId, "cowork:chat:c");
  assert.equal(parseVoice("chat gpt", home, { sessions }).provider, "chatgpt");
});
test("inside a session: short exact-ish commands work, longer speech is a message to the agent", () => {
  const st = { screen: "session", sessionId: "codex:a" };
  assert.deepEqual(parseVoice("Stop the task.", st, {}), { action: "stop", sessionId: "codex:a" });
  assert.equal(parseVoice("home", st, { sessions }).to, "home");
  assert.equal(parseVoice("read it", st, {}).action, "read");
  const msg = parseVoice("Open the config file and stop retrying when the test fails.", st, { sessions });
  assert.deepEqual([msg.action, msg.message], ["send", "Open the config file and stop retrying when the test fails."]);
  assert.equal(parseVoice("Tell Codex to also run the unit tests.", st, {}).action, "send");
});
test("new task: fuzzy head, fuzzy project, prompt kept verbatim", () => {
  assert.deepEqual(parseVoice("New task in Weekly Newsletter: draft the weekly update from last week's notes.", home, { projects }),
    { action: "create", provider: "cowork", project: "Weekly Newsletter", firstMessage: "draft the weekly update from last week's notes." });
  assert.deepEqual(parseVoice("start a new task in Heartwell Cramer to prep the agenda", home, { projects }),
    { action: "create", provider: "cowork", project: "Hartwell Kramer", firstMessage: "prep the agenda" });
  assert.deepEqual(parseVoice("New tusk: summarize my inbox", home, { projects }), { action: "create", provider: "cowork", project: undefined, firstMessage: "summarize my inbox" });
  assert.equal(parseVoice("new task in the morning, remind me to call Ana", home, { projects }).project, undefined);
  assert.equal(parseVoice("new task in Narnia: x", home, { projects }).action, "none");
});
test("home: free speech becomes a ChatGPT question; other list screens never guess", () => {
  assert.deepEqual(parseVoice("What's the weather like in Madrid tomorrow?", home, { sessions }), { action: "create", provider: "chatgpt", firstMessage: "What's the weather like in Madrid tomorrow?" });
  assert.equal(parseVoice("needs you", home, { sessions }).to, "needs");   // commands still win
  assert.equal(parseVoice("When was Lincoln born?", { screen: "working" }, { sessions }).provider, "chatgpt");   // any non-session screen
  assert.equal(parseVoice("When was Lincoln born?", { screen: "help" }, { sessions }).provider, "chatgpt");
  assert.equal(parseVoice("When was Lincoln born?", { screen: "session", sessionId: "codex:a" }, { sessions }).action, "send"); // in a session: to it
  assert.equal(parseVoice("hmm", { screen: "working" }, { sessions }).action === "create", false);   // one stray word is not a question
  assert.equal(parseVoice("", home, {}).action, "none");
});

test("help: works from anywhere, including inside a session (short phrase)", () => {
  for (const t of ["help", "What can I say?", "voice commands"]) assert.equal(parseVoice(t, { screen: "home" }, {}).action, "help", t);
  assert.equal(parseVoice("help", { screen: "session", sessionId: "codex:a" }, {}).action, "help");
});

test("walking-mode commands parse to walkmode (never to approve)", () => {
  for (const [t, on] of [["Normal mode.", false], ["walking mode", true], ["automatic mode", "auto"]]) {
    const r = parseVoice(t, { screen: "home" }, { requests: [{ requestId: "x", sessionId: "s", kind: "approval" }] });
    assert.deepEqual([r.action, r.on], ["walkmode", on], t);
  }
});

test("speech switch phrasing: 'turn off dictation' & friends, also inside a session", () => {
  const sess = { screen: "session", sessionId: "codex:a" };
  for (const t of ["Turn off dictation.", "dictation off", "stop reading", "please turn off the dictation", "mute"]) {
    assert.deepEqual([parseVoice(t, { screen: "home" }, {}).action, parseVoice(t, { screen: "home" }, {}).on], ["speech", false], t);
    assert.equal(parseVoice(t, sess, {}).action, "speech", `in session: ${t}`);
  }
  for (const t of ["Turn on dictation.", "dictation on", "speech on"]) assert.deepEqual([parseVoice(t, sess, {}).action, parseVoice(t, sess, {}).on], ["speech", true], t);
  // a longer sentence that merely mentions dictation still goes to the agent
  assert.equal(parseVoice("Can you turn off dictation in the settings file and restart the app?", sess, {}).action, "send");
});

test("free talk: commands act directly; free-form speech needs 'Glasses, …'; noise is quiet", () => {
  const home = { screen: "home" }, ctx = { free: true, requests: [{ requestId: "x", sessionId: "s", kind: "approval" }] };
  assert.equal(parseVoice("what needs me", home, ctx).to, "needs");
  assert.equal(parseVoice("approve", home, ctx).action, "approve");
  // free talk lets free-form speech through (still confirmed with a tap); the wake word is optional
  assert.deepEqual(parseVoice("When was Lincoln born?", home, ctx), { action: "create", provider: "chatgpt", firstMessage: "When was Lincoln born?" });
  assert.deepEqual([parseVoice("hmm", home, ctx).action, parseVoice("hmm", home, ctx).quiet], ["none", true]);
  assert.deepEqual(parseVoice("Glasses, when was Lincoln born?", home, ctx), { action: "create", provider: "chatgpt", firstMessage: "when was Lincoln born?" });
  assert.equal(parseVoice("hey glasses tell it to run the tests", { screen: "session", sessionId: "codex:a" }, ctx).action, "send");
  assert.deepEqual([parseVoice("free talk mode", home, {}).action, parseVoice("free talk mode", home, {}).on], ["freetalk", true]);
  assert.deepEqual([parseVoice("push to talk", home, ctx).action, parseVoice("push to talk", home, ctx).on], ["freetalk", false]);
});

test("lead-ins and 'dictation mode'", () => {
  for (const t of ["Tell me what's running.", "can you show me what's running", "please tell me what needs me"]) assert.equal(parseVoice(t, { screen: "home" }, {}).action, "nav", t);
  // "dictation" = the spoken replies (the user's term)
  assert.deepEqual([parseVoice("Dictation mode on.", { screen: "home" }, {}).action, parseVoice("Dictation mode on.", { screen: "home" }, {}).on], ["speech", true]);
  assert.deepEqual([parseVoice("dictation mode off", { screen: "home" }, {}).action, parseVoice("dictation mode off", { screen: "home" }, {}).on], ["speech", false]);
  assert.deepEqual([parseVoice("turn off dictation", { screen: "home" }, {}).action, parseVoice("turn off dictation", { screen: "home" }, {}).on], ["speech", false]);
});

test("confirm cards accept spoken answers; approvals need the word 'approve'", () => {
  const card = (proposal) => ({ screen: "voiceConfirm", voice: { transcript: "x", proposal } });
  const ask = card({ action: "create", provider: "chatgpt", firstMessage: "When was Lincoln born?" });
  for (const t of ["Do it.", "yes", "send it", "go ahead", "ok"]) assert.equal(parseVoice(t, ask, {}).action, "confirm", t);
  for (const t of ["cancel", "no", "never mind"]) assert.equal(parseVoice(t, ask, {}).action, "cancelConfirm", t);
  const appr = card({ action: "approve", requestId: "r", sessionId: "codex:a" });
  assert.equal(parseVoice("approve", appr, {}).action, "confirm");
  assert.equal(parseVoice("yes", appr, {}).action, "none");          // generic yes does not approve
  assert.equal(parseVoice("do it", appr, { free: true }).action, "none");
  assert.equal(parseVoice("cancel", appr, {}).action, "cancelConfirm");
  assert.equal(parseVoice("No, no! Don't send this.", ask, { free: true }).action, "cancelConfirm");
  assert.equal(parseVoice("Are we still in free talk?", ask, { free: true }).action, "none");   // the card stays
  assert.equal(parseVoice("what needs me", ask, { free: true }).action, "nav");                  // clear commands still work
});

test("system check: its own phrases (not 'status', which reads the session), from anywhere", () => {
  for (const t of ["system check", "Is everything working?", "health check", "run a check"]) assert.equal(parseVoice(t, { screen: "home" }, {}).action, "health", t);
  assert.equal(parseVoice("system check", { screen: "session", sessionId: "codex:a" }, {}).action, "health");
  assert.equal(parseVoice("status", { screen: "session", sessionId: "codex:a" }, {}).action, "read");
});

test("screen-aware open: rows on screen first, then this harness, then everything; ordinals; failed opens never ask ChatGPT", () => {
  const chat = ["Bike commute route ideas", "Garden layout plan", "Spanish verb drills", "Sourdough Starter Tips", "Kitchen remodel ideas", "Lincoln birth date"].map((t, i) => ({ sessionId: `chatgpt:${i}`, provider: "chatgpt", title: t }));
  const all = [...chat, { sessionId: "cowork:x", provider: "cowork", title: "Market research and pricing frameworks" }];
  const st = { screen: "sessions", provider: "chatgpt" }, ctx = { sessions: all, visible: chat.slice(0, 5), listProvider: "chatgpt" };
  const go = (u, c = ctx) => { const r = parseVoice(u, st, c); return [r.action, r.sessionId || r.provider || r.to]; };
  assert.deepEqual(go("Open sourdough starter tips."), ["nav", "chatgpt:3"]);
  assert.deepEqual(go("Open sour dough stater tips."), ["nav", "chatgpt:3"]);        // misheard, but clearly the row on screen
  assert.deepEqual(go("Sourdough starter tips"), ["nav", "chatgpt:3"]);           // a bare title on a list opens it
  assert.deepEqual(go("the second one"), ["nav", "chatgpt:1"]);
  assert.deepEqual(go("open the fourth one"), ["nav", "chatgpt:3"]);
  assert.deepEqual(go("Lincoln birth date"), ["nav", "chatgpt:5"]);             // not on screen: rest of this harness
  assert.deepEqual(go("Open market research"), ["nav", "cowork:x"]);             // not in this harness: everything
  assert.deepEqual(go("open chatgpt kitchen remodel"), ["nav", "chatgpt:4"]);   // harness named first narrows the search
  assert.deepEqual(go("Open ChatGPT."), ["nav", "chatgpt"]);
  const miss = parseVoice("Open the banana plan", st, ctx);
  assert.deepEqual([miss.action, miss.reason], ["none", 'no session called "the banana plan"']);
  assert.deepEqual(go("When was Lincoln born?"), ["create", "chatgpt"]);        // a real question still goes to ChatGPT
  assert.deepEqual(go("what needs me"), ["nav", "needs"]);                       // core commands still win on a list
});

test("'Did you mean' card: yes takes a single option, ordinals and names pick, cancel goes back", () => {
  const opt = (id, t) => ({ label: t, proposal: { action: "nav", to: "session", sessionId: id, heard: t } });
  const card = (opts) => ({ screen: "choose", voice: { transcript: "x", proposal: { action: "choose", options: opts } } });
  assert.equal(parseVoice("Yes.", card([opt("a", "Sourdough Starter Tips")]), {}).sessionId, "a");
  const two = card([opt("a", "Deck builder"), opt("b", "Research repo")]);
  assert.equal(parseVoice("the second one", two, {}).sessionId, "b");
  assert.equal(parseVoice("research repo", two, {}).sessionId, "b");
  assert.deepEqual(parseVoice("cancel", two, {}), { action: "nav", to: "back" });
  assert.notEqual(parseVoice("yes", two, {}).action, "nav");                     // "yes" is ambiguous with two options
});
