// Voice command parser: rule-based + fuzzy (no LLM decides what runs).
// Input: transcript, where the user is on the glasses, what is on the screen, and what exists (requests, sessions,
// projects). Layers, in order: core commands (whole phrase) → the screen's own rows and verbs → a widening search for
// "open …" (on screen → this harness → everything) → only then the free-speech fallback (a ChatGPT question).
// Output: ONE proposal. Navigation proposals run directly when confident (no side effects, undo = double-tap);
// action proposals (approve/deny/answer/stop/send/create) are always confirmed with a tap on the glasses.
// Unclear → {action:"choose", options:[...]} (a short "Did you mean…" list) or {action:"none", reason}.
import { norm, words, wordSim, phraseSim, intentSim, rank, decide, lev } from "./fuzzy.mjs";

const FILLER = new Set(["please", "hey", "ok", "okay", "um", "uh", "so", "just", "now", "glasses"]);
const STOPWORDS = new Set(["the", "a", "an", "to", "on", "in", "of", "my", "me", "one", "that", "this", "it", "session", "chat", "thread", "task", "go", "open", "switch", "show", "jump", "take"]);
const LEADIN = /^(?:(?:can|could|would) you |please |tell me |show me |let me (?:know|see) |i want to |i'd like to |go ahead and )+/;
const clean = (t) => words(t).filter((w) => !FILLER.has(w)).join(" ").replace(LEADIN, "");

// Whole-utterance intents (synonyms; fuzzy-matched, so "a prove", "approves", "nope" all land).
const INTENTS = [
  { key: "approve", phrases: ["approve", "approved", "yes approve", "approve it", "go ahead", "yes go ahead", "yes do it", "do it", "allow", "allow it", "accept", "yes", "yep", "sure"] },
  { key: "deny", phrases: ["deny", "denied", "deny it", "deny that", "no", "nope", "reject", "decline", "dont", "do not", "dont do it", "no dont"] },
  { key: "stop", phrases: ["stop", "stop it", "stop the task", "stop that", "kill it", "abort", "halt", "cancel the task", "stop working"] },
  { key: "home", phrases: ["home", "go home", "main screen", "start screen", "command center"] },
  { key: "back", phrases: ["back", "go back", "previous screen"] },
  { key: "needs", phrases: ["needs you", "what needs me", "needs me", "what needs you", "whats waiting", "what is waiting", "waiting on me", "inbox", "pending", "needs attention", "what needs attention"] },
  { key: "working", phrases: ["working", "whats running", "what is running", "running", "whats working", "in progress", "busy"] },
  { key: "sessions", phrases: ["all sessions", "sessions", "show sessions", "list sessions", "everything"] },
  { key: "next", phrases: ["next", "next one", "next item", "whats next", "what is next", "triage", "go through them", "start triage"] },
  { key: "read", phrases: ["read it", "read", "read that", "status", "whats the status", "what did it say", "repeat", "say it again", "summary", "summarize"] },
  { key: "mute", phrases: ["mute", "quiet", "be quiet", "stop talking", "speech off", "silent", "silence", "voice off", "turn off dictation", "dictation off", "stop dictation", "disable dictation", "turn off speech", "turn off voice", "turn off audio", "turn off reading", "stop reading", "audio off", "no audio", "mute replies", "turn off the voice"] },
  { key: "unmute", phrases: ["unmute", "speak", "talk to me", "speech on", "voice on", "read aloud", "turn on dictation", "dictation on", "start dictation", "enable dictation", "turn on speech", "turn on voice", "turn on audio", "turn on reading", "audio on", "turn on the voice"] },
  { key: "freeon", phrases: ["free talk mode", "free talk", "free talk on", "hands free", "hands free mode", "always listen", "listen mode"] },
  { key: "freeoff", phrases: ["push to talk", "push to talk mode", "free talk off", "stop free talk", "hands free off", "stop listening"] },
  { key: "health", phrases: ["system check", "system status", "health check", "check the system", "is everything working", "is everything ok", "check connections", "diagnostics", "run a check"] },
  { key: "help", phrases: ["help", "what can i say", "what can i do", "commands", "voice commands", "show commands", "list commands", "help me"] },
  { key: "walkon", phrases: ["walking mode", "walk mode", "big text", "big mode", "walking mode on"] },
  { key: "walkoff", phrases: ["normal mode", "walking mode off", "small text", "full screen", "detail mode"] },
  { key: "walkauto", phrases: ["automatic mode", "auto mode", "walking mode auto", "walking mode automatic"] },
];
const NAV = { home: { to: "home" }, back: { to: "back" }, needs: { to: "needs" }, working: { to: "working" }, sessions: { to: "sessions" } };
const HARNESS = [
  { key: "codex", phrases: ["codex", "code x"] }, { key: "claude-code", phrases: ["claude code", "claude", "cloud code", "clawed code"] },
  { key: "cowork", phrases: ["cowork", "co work", "cow work"] }, { key: "chatgpt", phrases: ["chatgpt", "chat gpt", "chat g p t", "gpt"] },
];
const OPEN = /^(?:go to|goto|open|open up|switch to|show me|show|jump to|take me to|pull up|bring up|look at)\s+(.+)$/;
const NEW_TASK_HEADS = ["new task", "start a task", "start a new task", "create a task", "create task", "new cowork task", "start task", "make a task", "begin a task"];

/** Score how well the spoken keywords appear in a title (ignores filler like "the", "one", "go to"). */
export function titleSim(spoken, title) {
  const s = words(spoken).filter((w) => !STOPWORDS.has(w) && !FILLER.has(w)), t = words(title);
  if (!s.length || !t.length) return 0;
  // every spoken keyword must STRONGLY match some title word (weak pairs count 0), so long titles can't win by volume
  const cover = s.reduce((a, w) => { const b = Math.max(...t.map((tw) => wordSim(w, tw))); return a + (b >= 0.86 ? b : 0); }, 0) / s.length;
  return t.length <= 6 ? Math.max(Math.min(phraseSim(spoken, title), cover + 0.1), cover * 0.97) : cover * 0.97;
}

/**
 * @param {string} transcript
 * @param {{screen:string, sessionId?:string, requestId?:string}} st
 * @param {{requests?:Array, sessions?:Array<{sessionId,provider,title,status?}>, visible?:Array<{sessionId,provider,title}>,
 *          listProvider?:string, projects?:string[], canSend?:boolean, free?:boolean, quickQuestions?:boolean}} ctx
 *   quickQuestions: false when ChatGPT is not enabled (free speech on home then isn't a question)
 *   sessions: every known session; visible: the session rows on the current screen, in order;
 *   listProvider: the harness whose list is on screen (e.g. after "go to ChatGPT").
 */
const WAKE = /^\s*(?:hey\s+|ok\s+)?(?:glasses|glass|classes)\b[\s,.:!-]*/i;
export function parseVoice(transcript, st = {}, ctx = {}) {
  // Free talk (no push-to-talk): commands act directly; free-form speech (questions, messages) needs the wake word
  // "Glasses, …" so conversations with other people don't trigger anything. Unrecognized speech is ignored quietly.
  if (ctx.free) {
    // Free talk = push-to-talk without holding: everything goes through (only the user's own voice reaches us, and
    // anything that sends/creates still needs a tap). "Glasses, …" is optional; unrecognized/empty speech is quiet.
    const r = parseVoice(String(transcript || "").replace(WAKE, ""), st, { ...ctx, free: false });
    return r.action === "none" || r.action === "choose" ? { ...r, quiet: true } : r;
  }
  const raw = String(transcript || "").trim(); const t = clean(raw); // raw (verbatim) is what gets sent; t is for matching
  // On a confirm card, speech answers the card. Approvals need the word "approve" (a stray "yes" can't run a command).
  if (st.screen === "voiceConfirm" && st.voice && st.voice.proposal && st.voice.proposal.action !== "none") {
    const pa = st.voice.proposal.action, a = norm(raw);   // match the words as spoken (fillers like "ok" matter here)
    if (/^(no|nope|nah|wait|stop|cancel|never ?mind|forget it|abort)\b|\b(don ?t|do not) (send|do|ask|approve)\b|\bcancel (it|that|this)\b/.test(a)) return { action: "cancelConfirm" };
    const generic = /^(yes|yeah|yep|ok|okay|sure|do it|send|send it|go|go ahead|confirm|confirmed|correct|right|please do|ask|ask it|yes please|yes do it|yes send it)( it| that| please)?$/.test(a);
    const approveWord = /^(yes )?(approve|approved|approve it|approves)( it| that| please)?$/.test(a);
    if (pa === "approve" ? approveWord : generic || approveWord) return { action: "confirm" };
    if (pa === "approve" && generic) return { action: "none", reason: 'say "approve" to approve this' };
    // anything else while a card is up: only a clear command acts; free-form speech never replaces the card
    const r = parseVoice(raw, { ...st, screen: st.stack && st.stack.length ? st.stack[st.stack.length - 1].screen : "home" }, { ...ctx, free: false });
    return ["create", "send", "choose", "none"].includes(r.action) ? { action: "none", quiet: true, reason: "say yes or cancel" } : r;
  }
  // On a "Did you mean…" card: "yes" takes the only option, "the second one" or its name picks one, "cancel" goes back.
  if (st.screen === "choose" && st.voice && st.voice.proposal && Array.isArray(st.voice.proposal.options)) {
    const opts = st.voice.proposal.options, a = norm(raw);
    if (/^(no|nope|cancel|never ?mind|forget it|none of (them|these)|back)\b/.test(a)) return { action: "nav", to: "back" };
    if (opts.length === 1 && /^(yes|yeah|yep|ok|okay|sure|do it|that one|that s it|correct|right|open it)( please)?$/.test(a)) return opts[0].proposal;
    const i = ordinal(t); if (i != null && opts[i]) return opts[i].proposal;
    const pick = matchOption(t, opts.map((o) => o.label)); if (pick) return opts.find((o) => o.label === pick).proposal;
  }
  if (!t) return { action: "none", reason: "I didn't catch anything" };
  const reqs = ctx.requests || [], sessions = ctx.sessions || [], n = t.split(" ").length;
  const inSession = !!st.sessionId && ["session", "actions", "request", "confirmStop"].includes(st.screen);

  // 1. New Cowork task: fuzzy head ("new task", "start a task", …), optional "in <project>" fuzzy-matched to known projects.
  const nt = newTask(raw, ctx.projects || []);
  if (nt) return nt;

  const scope = { visible: ctx.visible || [], listProvider: ctx.listProvider };

  // 2. On a list: "the second one", "number 3", "open the first one" pick a row on the screen.
  if (!inSession && scope.visible.length) { const i = ordinal(t); if (i != null && scope.visible[i]) return { action: "nav", to: "session", sessionId: scope.visible[i].sessionId, heard: scope.visible[i].title }; }

  // 2a. Open a session/harness by name: "go to codex", "open the deck one", "open ChatGPT sourdough starter".
  const om = t.match(OPEN);
  if (om && !(inSession && n > 6)) {
    const r = openTarget(om[1], sessions, scope);
    if (r) return r;
    // A failed "open …" is never a question for ChatGPT: say so instead.
    if (!inSession) return { action: "none", reason: `no session called "${om[1]}"` };
  }

  // 2b. Outside a session, a bare harness name ("codex", "chat gpt") opens it.
  if (!inSession) { const h = decide(rank(t, HARNESS, intentSim), { hi: 0.92, lo: 0.92 }); if (h.kind === "match") { const r = openTarget(t, sessions, scope); if (r) return r; } }

  // 3. Requests in scope: answer an option by fuzzy match before generic yes/no.
  const target = requestTarget(reqs, st);
  if (target && target.kind === "question") { const opt = matchOption(t, target.options || []); if (opt) return { action: "answer", requestId: target.requestId, answer: opt, sessionId: target.sessionId }; }

  // 3a. "hands free" toggles free talk ("dictation" is the user's word for the spoken replies → speech switch below)
  if (/\bhands free\b/.test(t)) return { action: "freetalk", on: !/\b(off|stop|disable|end)\b/.test(t) };

  // 3b. Speech on/off by explicit keywords (fuzzy matching can't tell "turn on" from "turn off" reliably).
  if (n <= 6) {
    const tw = t.split(" "), topic = tw.some((w) => /^(dictation|speech|voice|audio|reading|talking|sound|replies)$/.test(w));
    if (topic && tw.includes("mode") && !tw.some((w) => /^(off|stop|disable|mute)$/.test(w))) return { action: "speech", on: true };   // "dictation mode (on)"
    const off = tw.some((w) => /^(off|stop|disable|mute|silence)$/.test(w)), on = tw.some((w) => /^(on|start|enable|unmute|resume)$/.test(w));
    if (topic && off !== on) return { action: "speech", on };
  }

  // 4. Whole-utterance intents. Inside a session only short, confident phrases count as commands; longer speech is a message.
  // one-word utterances must also look alike (not just sound alike): "approves"→approve, but "hmm"↛home
  const oneWordSim = (a, b) => (words(b).length === 1 && lev(norm(a), norm(b)) < 0.6 ? 0 : intentSim(a, b));
  const intent = decide(rank(t, INTENTS, n === 1 ? oneWordSim : intentSim), { hi: 0.88, lo: 0.8 });
  const CONTROL = new Set(["mute", "unmute", "walkon", "walkoff", "walkauto", "help", "health", "home", "back", "freeon", "freeoff"]);
  const short = n <= 3 || (n <= 5 && intent.kind === "match" && CONTROL.has(intent.best.key) && intent.best.score >= 0.92);
  if (intent.kind === "match" && (!inSession || short)) {
    const k = intent.best.key;
    if (k === "approve" || k === "deny") {
      if (!target) return { action: "none", reason: reqs.length ? "more than one request is waiting; open the one you mean" : "nothing is waiting for approval" };
      if (target.kind === "question") return { action: "none", reason: "that's a question; say one of the options" };
      return { action: k, requestId: target.requestId, sessionId: target.sessionId };
    }
    if (k === "stop") return inSession ? { action: "stop", sessionId: st.sessionId } : { action: "none", reason: "open the session you want to stop" };
    if (NAV[k]) return { action: "nav", ...NAV[k], heard: intent.best.phrases[0] };
    if (k === "next") return { action: "next" };
    if (k === "help") return { action: "help" };
    if (k === "health") return { action: "health" };
    if (k === "freeon" || k === "freeoff") return { action: "freetalk", on: k === "freeon" };
    if (k === "read") return { action: "read", sessionId: inSession ? st.sessionId : undefined };
    if (k === "mute" || k === "unmute") return { action: "speech", on: k === "unmute" };
    if (k === "walkon" || k === "walkoff" || k === "walkauto") return { action: "walkmode", on: k === "walkauto" ? "auto" : k === "walkon" };
  }
  if (intent.kind === "maybe" && !inSession && short) {
    const options = intent.options.map((o) => ({ label: o.phrases[0], proposal: parseVoice(o.phrases[0], st, ctx) })).filter((o) => !["none", "choose"].includes(o.proposal.action));
    if (options.length) return { action: "choose", heard: raw, options };
  }

  // 5. Inside a session anything else is a message to it.
  if (inSession && ctx.canSend !== false) return { action: "send", sessionId: st.sessionId, message: raw };
  // 6. Outside a session: maybe a bare session/harness name.
  const r = openTarget(t, sessions, scope); if (r && r.action !== "choose") return r;
  // 7. Outside a session (home, lists, help…): anything else is a quick question for ChatGPT ("I just have a question").
  if (!inSession && t.split(" ").length >= 2 && ctx.quickQuestions !== false) return { action: "create", provider: "chatgpt", firstMessage: raw };
  if (r) return r;
  return { action: "none", reason: "say: needs you, working, next, go to <session>, or new task" };
}

function requestTarget(reqs, st) {
  const inScope = (r) => !st.sessionId || r.sessionId === st.sessionId;
  return reqs.find((r) => r.requestId === st.requestId) || (reqs.filter(inScope).length === 1 ? reqs.filter(inScope)[0] : null) || (reqs.length === 1 ? reqs[0] : null);
}

// Where "open …" looks, in order, and how sure it must be: rows on the screen (few candidates, so a weaker match is
// enough), then the rest of the harness whose list is on screen, then every session.
const SCOPES = [{ name: "visible", min: 0.75 }, { name: "harness", min: 0.85 }, { name: "all", min: 0.88 }];

/** "codex" → that harness's list; "ChatGPT sourdough starter" → that title within ChatGPT; "the deck one" → by title. */
function openTarget(spoken, sessions, scope = {}) {
  const h = decide(rank(spoken, HARNESS, intentSim), { hi: 0.9, lo: 0.85 });
  const kw = words(spoken).filter((w) => !STOPWORDS.has(w) && !FILLER.has(w));
  const isHarnessWord = (w, key) => HARNESS.find((x) => x.key === key).phrases.some((p) => words(p).some((pw) => wordSim(w, pw) >= 0.86));
  // Only a harness name was said ("go to codex"): open that harness's list, even if some titles contain the word.
  if (h.kind === "match" && kw.length && kw.every((w) => isHarnessWord(w, h.best.key))) {
    if (!sessions.some((s) => s.provider === h.best.key)) return { action: "none", reason: `no ${h.best.phrases[0]} sessions` };
    return { action: "nav", to: "sessions", provider: h.best.key, heard: h.best.phrases[0] };
  }
  // "ChatGPT sourdough starter": a harness name first narrows the search to that harness.
  let pool = sessions, rest = spoken, explicit = null;
  for (const x of HARNESS) for (const p of x.phrases) {
    const pw = words(p), sw = words(spoken);
    if (sw.length > pw.length && pw.every((w, i) => wordSim(sw[i], w) >= 0.86)) { explicit = x.key; rest = sw.slice(pw.length).join(" "); }
  }
  if (explicit) pool = sessions.filter((s) => s.provider === explicit);
  const tiers = { visible: explicit ? (scope.visible || []).filter((s) => s.provider === explicit) : scope.visible || [],
    harness: pool.filter((s) => s.provider === (explicit || scope.listProvider)), all: pool };
  const ranked = (list) => list.map((s) => ({ s, score: titleSim(rest, s.title || "") })).sort((a, b) => b.score - a.score);
  for (const { name, min } of SCOPES) {
    const r = ranked(tiers[name] || []);
    if (r[0] && r[0].score >= min && (!r[1] || r[0].score - r[1].score >= 0.04)) return { action: "nav", to: "session", sessionId: r[0].s.sessionId, heard: r[0].s.title, scope: name };
  }
  const close = ranked(pool).filter((x) => x.score >= 0.7).slice(0, 3);
  if (close.length) return { action: "choose", heard: spoken, options: close.map((x) => ({ label: x.s.title, proposal: { action: "nav", to: "session", sessionId: x.s.sessionId, heard: x.s.title } })) };
  return null;
}

/** "the second one", "number 3", "open the first one", "third" → 0-based row index; anything else → null. */
export function ordinal(t) {
  const N = { first: 0, one: 0, "1": 0, second: 1, two: 1, "2": 1, third: 2, three: 2, "3": 2, fourth: 3, four: 3, "4": 3, fifth: 4, five: 4, "5": 4, sixth: 5, six: 5, "6": 5, last: -1 };
  const m = norm(t).match(/^(?:(?:open|go to|show me|pick|select) )?(?:the |number |row |item )?(first|second|third|fourth|fifth|sixth|one|two|three|four|five|six|[1-6])(?: one| row| item| session)?$/);
  return m ? N[m[1]] : null;
}

function newTask(raw, projects) {
  const w = words(raw).filter((x) => !FILLER.has(x));
  for (let k = 2; k <= 4 && k <= w.length; k++) {
    const head = w.slice(0, k).join(" ");
    if (Math.max(...NEW_TASK_HEADS.map((h) => intentSim(head, h))) < 0.85 || !w.slice(0, k).some((x) => wordSim(x, "task") >= 0.85 || wordSim(x, "cowork") >= 0.9)) continue;
    let rest = w.slice(k);
    if (!rest.length) return { action: "none", reason: "say what the new task should do" };
    let project;
    if (rest[0] === "in" || rest[0] === "for") {
      let best = { score: 0, j: 0 };   // best known project matching the next 1..6 spoken words
      for (const p of projects) for (let j = 1; j <= Math.min(6, rest.length - 1); j++) {
        const sc = phraseSim(rest.slice(1, 1 + j).join(" "), p); if (sc > best.score + 0.001 || (Math.abs(sc - best.score) <= 0.001 && j > best.j)) best = { p, j, score: sc };
      }
      if (best.score >= 0.88) { project = best.p; rest = rest.slice(1 + best.j); }
      else if (/:/.test(raw.split(/\b(?:in|for)\b/i)[1] || "")) return { action: "none", reason: `no project called "${(raw.split(/\b(?:in|for)\b/i)[1] || "").split(":")[0].trim()}"` };
    }
    const prompt = dropWords(raw, w.length - rest.length).replace(/^[\s:,.-]+/, "").replace(/^(?:to|that|which)\s+/i, "").trim();
    if (!prompt) return { action: "none", reason: "say what the new task should do" };
    return { action: "create", provider: "cowork", project, firstMessage: prompt };
  }
  return null;
}
function dropWords(raw, n) { // remove the first n (non-filler) words from the original string, keeping the rest verbatim
  if (n <= 0) return raw;
  const re = /[A-Za-z0-9’'&]+/g; let m, count = 0;
  while ((m = re.exec(raw))) { if (FILLER.has(norm(m[0]))) continue; if (++count === n) return raw.slice(m.index + m[0].length); }
  return "";
}

/** Option by fuzzy text, "option N"/ordinal, or letter ("option b" ↔ "option-b.txt"). */
export function matchOption(t, options) {
  if (!options.length) return null;
  t = norm(t).replace(/^(?:answer|choose|pick|select|go with|i choose|lets go with)\s+/, "").replace(/ (?:dot|point|period) /g, " "); // "option b dot txt"
  const ord = { first: 1, one: 1, "1": 1, second: 2, two: 2, "2": 2, third: 3, three: 3, "3": 3, fourth: 4, four: 4, "4": 4, last: options.length };
  const m = t.match(/^(?:option |number |the )?(first|second|third|fourth|last|one|two|three|four|[1-4])(?: one| option)?$/);
  if (m && options[ord[m[1]] - 1]) return options[ord[m[1]] - 1];
  const l = t.match(/^(?:option |letter )?([a-d]|bee|be|see|sea|dee)$/);
  if (l) {
    const letter = { bee: "b", be: "b", see: "c", sea: "c", dee: "d" }[l[1]] || l[1];
    const hit = options.filter((o) => { const n2 = norm(o); return new RegExp(`(^| )(option )?${letter}( |$)`).test(n2); });
    if (hit.length === 1) return hit[0];
    if (!hit.length && options[letter.charCodeAt(0) - 97]) return options[letter.charCodeAt(0) - 97];
  }
  const ranked = options.map((o) => ({ key: o, phrases: [o], score: titleSim(t, o) })).sort((a, b) => b.score - a.score);
  const d = decide(ranked, { hi: 0.88, lo: 0.88 });
  return d.kind === "match" ? d.best.key : null;
}
