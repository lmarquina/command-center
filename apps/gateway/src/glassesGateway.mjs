// Glasses gateway: WebSocket endpoint for the Even Hub phone app (thin renderer on the glasses).
// The phone app sends {type:"hello", token} then {type:"input", event, index}; we send {type:"render", mode, page}.
// All navigation + provider handling lives here/in SessionCore. Client id "g2" for the writer lease.
import crypto from "node:crypto";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { buildHome, foldLive } from "./viewModel.mjs";
import { render, reduce, needsRebuild, stepsFrom } from "./screens.mjs";
import { parseVoice } from "./voiceCommands.mjs";
import { providerLabel } from "./viewModel.mjs";
import { createPush } from "./push.mjs";
import { MotionDetector } from "./motion.mjs";
import { renderWalk, chunks } from "./walk.mjs";
import { appender } from "@command-center/core/appender.mjs";

const CLIENT = "g2";

/** Constant-time token check. Compares bytes, not characters: equal-length strings of multi-byte characters made
 *  timingSafeEqual throw, which crashed the gateway for an unauthenticated client. */
export function tokenEquals(given, expected) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Defaults for the values in config `gateway.glasses.tuning`. */
export const TUNING = { maxRecordingSeconds: 300, minPaintMs: 1000, homeRefreshMs: 30000, healthRefreshMs: 60000 };

export function startGlassesGateway({ agentd, live, token, port = 3100, host = "0.0.0.0", allowedOrigins = [], log = () => {}, voiceUrl = "http://127.0.0.1:3200", speakEvents = true, tls = null, runDir = null, tuning = {}, localPort, providers = null }) {
  const T = { ...TUNING, ...tuning };
  const latest = {};                 // sessionId -> latest assistant text (from events)
  let homeCache = null, homeAt = 0, projects = [], allSessions = [];
  const conns = new Set();

  // Stale-while-revalidate: with a cached view, return it immediately and refresh in the background (one at a time),
  // so a slow bridge call (e.g. ChatGPT typing) never freezes the glasses. Only the very first load waits.
  let refreshing = null;
  async function home(force) {
    if (homeCache && !force) {
      if (Date.now() - homeAt >= (homeAt === 0 ? 0 : T.homeRefreshMs) && !refreshing) refreshing = loadHome().then(() => { for (const c of conns) if (c.ready) schedulePaint(c); }).catch(() => {}).finally(() => { refreshing = null; });
      return homeCache;
    }
    return loadHome();
  }
  async function loadHome() {
    const [list, attention] = await Promise.all([agentd.request("sessions", {}), agentd.request("attention", {})]);
    homeCache = buildHome({ sessions: list.sessions, attention, live }); homeAt = Date.now();
    allSessions = list.sessions;   // full list (the home summary keeps only ~25 recent)
    projects = [...new Set(list.sessions.map((x) => x.project).filter(Boolean))];
    return homeCache;
  }
  // System check (agentd's checks + the voice service), cached like the home view: screens draw from the cache
  // and a refresh runs in the background when it is old. Screens repaint only if a result changed.
  let healthCache = null, healthAt = 0, healthRefreshing = null;
  function refreshHealth() {
    if (healthRefreshing) return healthRefreshing;
    healthRefreshing = (async () => {
      let checks;
      try { checks = await agentd.request("health", {}, 40000); } catch { checks = [{ id: "agentd", ok: false, label: "Session service not running: npm run dev" }]; }
      const voiceUp = await fetch(voiceUrl + "/health", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
      checks = [...checks, voiceUp ? { id: "voice", ok: true, label: "Voice service running" } : { id: "voice", ok: false, label: "Voice service down: no speech" }];
      const changed = JSON.stringify(checks) !== JSON.stringify(healthCache);
      healthCache = checks; healthAt = Date.now();
      if (changed) for (const c of conns) if (c.ready) schedulePaint(c);
      return checks;
    })().finally(() => { healthRefreshing = null; });
    return healthRefreshing;
  }
  const healthSummary = (checks) => { const bad = checks.filter((x) => !x.ok); return bad.length ? `${bad.length} problem${bad.length > 1 ? "s" : ""}. ${bad.map((x) => x.label).join(". ")}.` : "Everything is connected."; };

  const requestsFrom = (h) => h.needsYou.filter((n) => n.requestId).map((n) => ({ requestId: n.requestId, sessionId: n.sessionId, provider: n.provider, kind: n.kind, text: n.text, options: n.options }));

  async function data(c, force) {
    const h = await home(force);
    if (Date.now() - healthAt > (c.st.screen === "health" ? 5000 : T.healthRefreshMs)) refreshHealth().catch(() => {});
    const d = { home: h, requests: requestsFrom(h), live, speech: c.speech !== false, free: !!c.free, allSessions, health: healthCache || [] };
    if (c.st.sessionId) {
      // Draw first, fetch after: only screens that show the transcript need it, and they open immediately with
      // what we know (title, status); the transcript is fetched in the background and repainted when it arrives.
      const sid = c.st.sessionId;
      if (SESSION_SCREENS.has(c.st.screen) && (!c.session || c.session.sessionId !== sid || force)) fetchSession(c, sid);
      const known = allSessions.find((x) => x.sessionId === sid) || {};
      d.session = c.session && c.session.sessionId === sid ? c.session : { sessionId: sid, provider: known.provider || sid.split(":")[0], title: known.title, status: known.status, loading: true, messages: [] };
      d.live = live[sid];
      d.latestText = latest[sid] || lastExchange(d.session) || (d.session.loading ? "Loading the latest messages..." : ""); // nothing streamed yet → latest exchange
      if (c.st.screen === "substeps" || c.st.screen === "stepdetail") stepData(c, d);
    }
    return d;
  }
  // Cowork step groups are read on demand through the bridge (slow-ish: expand/read/collapse in the background tab).
  // The screen first renders "Opening...", then repaints when the read finishes. Results cached per connection.
  function stepData(c, d) {
    const g = (stepsFrom(c.session)[c.st.index] || {}).group;
    if (!g) { d.substeps = { error: "step group not found" }; return; }
    const gk = `${c.st.sessionId}|${g.turnKey}|${g.index}`;
    c.stepCache = c.stepCache || {};
    const fetchOnce = (key, method, params) => {
      if (c.stepCache[key] !== undefined) return c.stepCache[key];
      c.stepCache[key] = null;
      agentd.request(method, { sessionId: c.st.sessionId, turnKey: g.turnKey, group: g.index, ...params })
        .then((r) => { c.stepCache[key] = r; }, (e) => { c.stepCache[key] = { error: e.message }; })
        .then(() => paint(c).catch(() => {}));
      return null;
    };
    d.substeps = fetchOnce(gk, "steps", {});
    if (c.st.screen === "stepdetail" && c.st.openable) d.stepDetail = fetchOnce(`${gk}|${c.st.stepKey}`, "stepOpen", { stepKey: c.st.stepKey });
  }
  // Walking mode: big-type pages (phone renders the text into 4 image tiles). Overlays (listening/confirm) render big too.
  const walking = (c) => (c.walkOverride != null ? c.walkOverride : c.motionState === "walking");
  const SESSION_SCREENS = new Set(["session", "actions", "steps", "step", "substeps", "stepdetail"]);
  function fetchSession(c, sid) {
    if (c.fetching === sid) return; c.fetching = sid;
    agentd.request("get", { sessionId: sid, limit: 40 }).catch(() => ({ sessionId: sid }))
      .then((r) => { if (c.fetching === sid) c.fetching = null; if (c.st.sessionId === sid) { c.session = { ...r, sessionId: sid }; paint(c).catch(() => {}); } });
  }
  async function paint(c, force) {
    const d = await data(c, force);
    const pg = walking(c) ? renderWalk(c.walk || (c.walk = { mode: "glance" }), c.st, d) : render(c.st, d);
    const rebuild = force || needsRebuild(c.page, pg);
    if (pg.big) {   // walk pages: same 5 containers every time → only the big content changes (tiles re-rendered on the phone)
      if (rebuild || !c.page || !c.page.big) send(c, { type: "render", mode: "rebuild", page: pg });
      else if (JSON.stringify(pg.big) !== JSON.stringify(c.page.big)) send(c, { type: "render", mode: "big", big: pg.big });
      c.page = pg; return;
    }
    if (rebuild) send(c, { type: "render", mode: "rebuild", page: pg });
    else {
      const updates = pg.containers.filter((x, i) => x.kind === "text" && x.content !== c.page.containers[i].content).map((x) => ({ containerID: x.containerID, containerName: x.containerName, content: x.content }));
      if (updates.length) send(c, { type: "render", mode: "update", updates });
    }
    c.page = pg;
  }
  const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };

  async function onInput(c, m) {
    if (c.page && c.page.big && c.page.screen === "w-confirm") {   // big confirm: tap = do it, double-tap = cancel
      const p = (c.st.voice || {}).proposal || {}; const s2 = [...(c.st.stack || [])]; const prev = s2.pop() || { screen: "home" };
      if (m.event === "double_click" || (m.event === "click" && (p.action === "none" || c.st.screen === "choose"))) { c.st = { ...prev, stack: s2 }; return paint(c, true); }
      if (m.event !== "click") return;
      c.st = { ...prev, stack: s2 };
      try { await runVoice(c, p); } catch (e) { send(c, { type: "toast", text: `Error: ${e.message}`.slice(0, 120) }); speak(c, "That didn't work."); }
      if (c.walk && c.walk.mode === "request") c.walk = { mode: "glance" };
      return paint(c, true);
    }
    if (c.page && c.page.big && c.page.screen !== "w-listening") return walkInput(c, m);
    const t0 = Date.now();
    const { st, effect } = reduce(c.st, c.page, { event: m.event, index: m.index });
    c.st = st;
    try {
      if (effect) {
        if (effect.approve) await agentd.request("approve", { requestId: effect.approve, client: CLIENT });
        if (effect.deny) await agentd.request("deny", { requestId: effect.deny, client: CLIENT });
        if (effect.answer) await agentd.request("answer", { requestId: effect.requestId, answer: effect.answer, client: CLIENT });
        if (effect.stop) await agentd.request("interrupt", { sessionId: effect.stop, client: CLIENT });
        if (effect.voice) { await runVoice(c, effect.voice); send(c, { type: "ack", ms: Date.now() - t0, screen: c.st.screen }); return paint(c, true); }
        if (effect.free !== undefined) { setFree(effect.free); send(c, { type: "toast", text: effect.free ? "◉ Free talk on" : "Push to talk" }); if (effect.free) speak(c, "Free talk on. Start questions with: Glasses."); }
        if (effect.speech !== undefined) { setSpeech(effect.speech); send(c, { type: "toast", text: `Speech ${prefs.speech ? "on" : "off"}` }); if (prefs.speech) speak(c, "Speech on"); }
        if (effect.approve || effect.deny || effect.answer || effect.stop) { const msg = effect.approve ? "Approved" : effect.deny ? "Denied" : effect.answer ? `Answered: ${effect.answer}` : "Stop sent"; send(c, { type: "toast", text: msg }); speak(c, msg, providerOf(c.st.sessionId || effect.stop || String(effect.approve || effect.deny || effect.requestId || ""))); if (!effect.stop) triageAdvance(c); }
      }
      if (c.session && c.session.sessionId === st.sessionId && !(effect && (effect.refresh || effect.stop || effect.voice))) { /* same session: keep it */ } else c.session = null;
      await paint(c, !!(effect && effect.refresh));
      send(c, { type: "ack", ms: Date.now() - t0, screen: c.st.screen });
    } catch (e) {
      log("g2 action error", e.code, e.message);
      send(c, { type: "toast", text: `Error: ${e.code || ""} ${e.message}`.slice(0, 120) });
      await paint(c, true);
    }
  }

  // ---------- voice: push-to-talk → STT → rule-based proposal → confirm on glasses → execute → spoken result ----------
  const MAX_PTT_S = T.maxRecordingSeconds, MAX_PTT_BYTES = 16000 * 2 * MAX_PTT_S; // 5 min of 16 kHz s16le (≥15 s goes to cloud STT)
  async function voice(path, body, headers) {
    const r = await fetch(voiceUrl + path, { method: "POST", body, headers });
    if (!r.ok) throw Object.assign(new Error(`voice ${path}: ${(await r.text()).slice(0, 160)}`), { code: "VOICE" });
    return r;
  }
  async function pttStart(c, auto) {
    if (c.ptt) { clearTimeout(c.ptt.timer); c.st = c.ptt.prev; c.ptt = null; log("g2 ptt", "new hold replaced an unfinished one"); }
    c.ptt = { chunks: [], bytes: 0, prev: c.st, prevPage: c.page, t0: Date.now(), auto: !!auto };
    if (auto) { send(c, { type: "toast", text: "◉ listening" }); c.ptt.timer = setTimeout(() => pttEnd(c).catch(() => {}), 181000); return; }
    c.ptt.timer = setTimeout(() => { log("g2 ptt", `no release after ${MAX_PTT_S} s: finishing`); pttEnd(c).catch(() => {}); }, (MAX_PTT_S + 1) * 1000);
    c.st = { ...c.st, screen: "listening", stack: [...(c.st.stack || []), { screen: c.st.screen, sessionId: c.st.sessionId, requestId: c.st.requestId }] };
    await paint(c, true);
  }
  // Live level meter on the listening screen: a scrolling 12-bar graph of the incoming audio, ≤5 updates/s.
  const BLOCKS = "▁▂▃▄▅▆▇█";
  function pttAudio(c, buf) {
    if (!c.ptt || c.ptt.bytes >= MAX_PTT_BYTES) return;
    c.ptt.chunks.push(buf); c.ptt.bytes += buf.length;
    let sum = 0; const n = Math.floor(buf.length / 2); for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; sum += v * v; }
    const lvl = Math.min(1, Math.sqrt(sum / Math.max(1, n)) * 6);
    c.ptt.levels = [...(c.ptt.levels || []), lvl].slice(-12);
    if (Date.now() - (c.ptt.lastMeter || 0) >= 200 && c.st.screen === "listening") {
      c.ptt.lastMeter = Date.now();
      const meter = c.ptt.levels.map((v) => BLOCKS[Math.min(7, Math.round(v * 7))]).join("").padStart(12, "▁");
      const el = Math.floor((Date.now() - c.ptt.t0) / 1000), fmt = (x) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
      const note = `Speak now. Release to finish.   ${fmt(el)} / ${fmt(MAX_PTT_S)}`;
      c.st = { ...c.st, level: meter, note };
      if (!(c.page && c.page.big)) send(c, { type: "render", mode: "update", updates: [{ containerID: 2, containerName: "body", content: note }] });
      if (c.page && c.page.big) { if (Date.now() - (c.ptt.lastBig || 0) >= 500) { c.ptt.lastBig = Date.now(); paint(c).catch(() => {}); } }
      else send(c, { type: "render", mode: "update", updates: [{ containerID: 4, containerName: "level", content: meter }] });
    }
  }
  async function pttEnd(c) {
    const p = c.ptt; c.ptt = null; if (!p) return; clearTimeout(p.timer);
    const back = () => { c.st = p.prev; return paint(c, true); };
    if (p.bytes < 16000 * 2 * 0.3) { if (p.auto) return; send(c, { type: "toast", text: "Too short - hold while you speak" }); return back(); }
    const tRelease = Date.now();
    if (!p.auto) { c.st = { ...c.st, note: "Transcribing..." }; await paint(c); }
    const screenCtx = screenContext(p.prev, p.prevPage);   // what was on the glasses when the user spoke
    let stt;
    try { stt = await (await voice(`/stt?save=1&context=${encodeURIComponent(vocabulary(screenCtx))}`, Buffer.concat(p.chunks), { "Content-Type": "application/octet-stream" })).json(); }
    catch (e) { log("g2 stt error", e.message); send(c, { type: "toast", text: "Voice unavailable" }); return back(); }
    if (stt.text && !/[A-Za-zÀ-ÿ]/.test(stt.text)) { log("g2 voice", `discarded non-Latin transcript (noise): ${stt.text.slice(0, 40)}`); stt.text = ""; }
    return handleUtterance(c, stt, { prev: p.prev, screenCtx, auto: p.auto, t0: p.t0, tRelease });
  }
  /** One utterance, from speech or typed (demo/test hook), through interpretation to the screen. */
  async function handleUtterance(c, stt, { prev, screenCtx, auto, t0, tRelease }) {
    const p = { prev, auto, t0 };
    const tStt = Date.now();
    const h = await home().catch(() => null);
    const requests = h ? requestsFrom(h) : [];
    const proposal = parseVoice(stt.text, p.prev, { requests, projects, sessions: allSessions.length ? allSessions.map((x) => ({ sessionId: x.sessionId, provider: x.provider, title: x.title })) : sessionsFor(h), ...screenCtx, free: p.auto, quickQuestions: !providers || providers.includes("chatgpt") });
    const tParse = Date.now();
    const evalRow = { at: new Date().toISOString(), mode: "commands", text: stt.text, screen: p.prev.screen, listProvider: screenCtx.listProvider, visible: screenCtx.visible.map((x) => x.title), free: !!p.auto,
      proposal: { action: proposal.action, to: proposal.to, sessionId: proposal.sessionId, provider: proposal.provider, heard: proposal.heard, scope: proposal.scope },
      ms: { speaking: tRelease - p.t0, stt: tStt - tRelease, sttServer: stt.ms, sttEngine: stt.engine, interpret: tParse - tStt } };
    const logEval = (extra = {}) => { if (writeEval) writeEval(JSON.stringify({ ...evalRow, ...extra, ms: { ...evalRow.ms, ...(extra.ms || {}) } })); };
    if (p.auto && (proposal.quiet || !stt.text)) { log("g2 voice", JSON.stringify({ free: true, ignored: stt.text.slice(0, 60) })); logEval({ ignored: true }); c.st = p.prev; return; }   // free talk: ignore quietly
    log("g2 voice", JSON.stringify({ ms: Date.now() - p.t0, stt: stt.engine, sttMs: stt.ms, text: stt.text, action: proposal.action }));
    const push = (screen, extra = {}) => { c.st = { ...p.prev, screen, ...extra, stack: [...(p.prev.stack || []), { screen: p.prev.screen, sessionId: p.prev.sessionId, requestId: p.prev.requestId }] }; };
    if (IMMEDIATE.has(proposal.action)) {           // no side effects → run now; "Heard: …" shown, double-tap undoes
      c.st = p.prev;
      try { await runVoice(c, proposal, stt.text); } catch (e) { log("g2 voice action", e.message); send(c, { type: "toast", text: `Couldn't do that: ${e.message}`.slice(0, 100) }); }
      await paint(c, true); logEval({ ms: { toScreen: Date.now() - tRelease } }); return;
    }
    if (proposal.action === "choose") { push("choose", { voice: { transcript: stt.text, proposal } }); await paint(c, true); logEval({ ms: { toScreen: Date.now() - tRelease } }); return speak(c, "Did you mean one of these?"); }
    push("voiceConfirm", { voice: { transcript: stt.text, proposal } });
    await paint(c, true); logEval({ ms: { toScreen: Date.now() - tRelease } });
    speak(c, proposal.action === "none" ? proposal.reason : null);
  }
  // ---------- walking mode ----------
  async function walkInput(c, m) {
    const w = c.walk || (c.walk = { mode: "glance" });
    if (w.mode === "read" && w.read) {
      const r = w.read;
      if (m.event === "click") r.paused = !r.paused;
      else if (m.event === "up") { r.i = Math.max(0, r.i - 1); r.paused = true; }
      else if (m.event === "down") { r.i = Math.min(r.parts.length - 1, r.i + 1); r.paused = true; }
      else if (m.event === "double_click") { clearTimeout(r.timer); c.walk = { mode: "glance" }; }
      if (!r.paused) readTick(c);
      return paint(c);
    }
    if (m.event === "double_click") { c.walk = { mode: "glance" }; return paint(c); }
    if (m.event !== "click") return;
    if (w.mode === "request") {   // tap on a request → big confirm (approve), questions are answered by voice
      const h = await home().catch(() => null); const r = h && requestsFrom(h).find((x) => x.requestId === w.requestId);
      if (r && r.kind !== "question") { c.st = { ...c.st, screen: "voiceConfirm", voice: { transcript: "(tap)", proposal: { action: "approve", requestId: r.requestId, sessionId: r.sessionId } }, stack: [...(c.st.stack || []), { screen: c.st.screen }] }; return paint(c, true); }
      return speak(c, r ? "Say the option you want." : "That request is gone.");
    }
    // glance: tap = next waiting item, read aloud
    const h = await home(true).catch(() => null); const reqs = h ? requestsFrom(h) : [];
    if (!reqs.length) { speak(c, h ? listSummary(h, "needs") : "I can't reach the Mac."); return paint(c); }
    const r = reqs[0]; c.walk = { mode: "request", requestId: r.requestId };
    speak(c, spokenFor({ type: r.kind === "question" ? "question.requested" : "approval.requested", provider: r.provider, request: { description: r.text, question: r.kind === "question" ? [{ text: r.text, options: r.options || [] }] : undefined } }), r.provider);
    return paint(c);
  }
  // Word-by-word reader: big chunks in one place, ~1 per second (tile updates take ~0.4 s); tap pauses, swipe steps.
  function startReading(c, who, text) {
    const parts = chunks(text); if (!parts.length) return;
    if (c.walk && c.walk.read) clearTimeout(c.walk.read.timer);
    c.walk = { mode: "read", read: { who, parts, i: 0, paused: false } }; paint(c).catch(() => {}); readTick(c);
  }
  function readTick(c) {
    const r = c.walk && c.walk.read; if (!r) return; clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      if (!c.walk || c.walk.read !== r || r.paused) return;
      if (r.i >= r.parts.length - 1) { r.timer = setTimeout(() => { if (c.walk && c.walk.read === r) { c.walk = { mode: "glance" }; paint(c).catch(() => {}); } }, 2500); return; }
      r.i++; paint(c).catch(() => {}); readTick(c);
    }, 450 + 170 * r.parts[r.i].split(" ").length);
  }
  const imuLog = runDir ? { write: appender(path.join(runDir, "imu.jsonl"), { maxBytes: 10e6 }) } : null; // raw samples for calibration
  function onImu(c, m) {
    c.motion = c.motion || new MotionDetector();
    if (imuLog) imuLog.write(JSON.stringify({ t: Date.now(), x: m.x, y: m.y, z: m.z }) + "\n");
    const changed = c.motion.push({ x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, t: Date.now() });
    if ((c.imuN = (c.imuN || 0) + 1) % 50 === 0) log("g2 imu", JSON.stringify({ state: c.motion.state, ...c.motion.lastStats }));
    if (!changed) return;
    c.motionState = changed; log("g2 motion", changed);
    if (c.walkOverride == null) { if (changed === "walking") c.walk = { mode: "glance" }; paint(c, true).catch(() => {}); }
  }

  const IMMEDIATE = new Set(["nav", "next", "read", "speech", "walkmode", "help", "health", "freetalk", "confirm", "cancelConfirm"]);
  // Ordered for "go to codex": needs-you sessions first, then working, then recent (deduplicated).
  function sessionsFor(h) {
    if (!h) return [];
    const seen = new Set(), out = [];
    for (const x of [...h.needsYou, ...h.working, ...h.recent]) if (x.sessionId && !seen.has(x.sessionId)) { seen.add(x.sessionId); out.push({ sessionId: x.sessionId, provider: x.provider, title: x.title }); }
    return out;
  }
  // Words to expect, sent with each recording to bias transcription (harness names, projects, recent session titles).
  // Keep it SHORT and name-like: long titles (some are whole pasted prompts) derail the transcriber into empty output.
  // The session rows on a page (in order) and whose list it is, for the parser and the speech hints.
  function screenContext(st, page) {
    const byId = new Map(allSessions.map((x) => [x.sessionId, x]));
    const visible = ((page && page.items) || []).filter((i) => i.action && i.action.go === "session" && i.action.sessionId)
      .map((i) => { const x = byId.get(i.action.sessionId) || {}; return { sessionId: i.action.sessionId, provider: x.provider || i.action.sessionId.split(":")[0], title: x.title || i.label }; });
    return { visible, listProvider: st && st.screen === "sessions" ? st.provider : undefined };
  }
  function vocabulary(screenCtx = { visible: [] }) {
    const nameLike = (t) => t && t.length <= 48 && t.split(/\s+/).length <= 6 && !/[\n:{}()<>]/.test(t);
    // what is on screen comes first: those are the names the user is about to say
    const titles = [...screenCtx.visible.map((x) => x.title), ...(homeCache ? sessionsFor(homeCache).map((x) => x.title) : [])].filter(nameLike).slice(0, 12);
    const terms = [...new Set(["Glasses", "Cowork", "Codex", "Claude Code", "ChatGPT", ...projects.filter(nameLike), ...titles])];
    let out = "Names: "; for (const t of terms) { if ((out + t).length > 300) break; out += t + ", "; }
    return out.replace(/, $/, ".");
  }
  // Triage: walk the needs-you requests one by one; each is read aloud in its harness's voice.
  async function triageNext(c) {
    homeAt = 0; const h = await home(true).catch(() => null); const reqs = h ? requestsFrom(h) : [];
    if (!reqs.length) { c.triage = false; c.st = { screen: "home", stack: [] }; await paint(c, true); return speak(c, "All clear. Nothing needs you."); }
    const r = reqs[0]; c.triage = true;
    c.st = { screen: "request", requestId: r.requestId, sessionId: r.sessionId, stack: [{ screen: "home" }, { screen: "needs" }] }; c.session = null;
    await paint(c, true);
    speak(c, spokenFor({ type: r.kind === "question" ? "question.requested" : "approval.requested", provider: r.provider, request: { description: r.text, question: r.kind === "question" ? [{ text: r.text, options: r.options || [] }] : undefined } }) + (reqs.length > 1 ? ` ${reqs.length - 1} more after this.` : ""), r.provider);
  }
  function triageAdvance(c) { if (c.triage) setTimeout(() => triageNext(c).catch((e) => log("triage", e.message)), 1500); }

  async function runVoice(c, p, heard) {
    const who = providerOf(p.sessionId || (p.action === "create" ? p.provider : ""));
    const say = (m) => { send(c, { type: "toast", text: m }); speak(c, m, who); };
    if (["send", "answer", "approve", "deny"].includes(p.action)) watch(p.sessionId);
    const toast = (m) => send(c, { type: "toast", text: m });
    switch (p.action) {
      case "nav": {
        toast(`Heard: ${p.heard || heard || p.to}`);
        if (p.to === "back") { const s2 = [...(c.st.stack || [])]; const prev = s2.pop() || { screen: "home" }; c.st = { ...prev, stack: s2 }; return; }
        if (p.to === "home") { c.triage = false; c.st = { screen: "home", stack: [] }; return; }
        if (p.to === "session") { c.st = { screen: "session", sessionId: p.sessionId, stack: [...(c.st.stack || []), { screen: c.st.screen, sessionId: c.st.sessionId, requestId: c.st.requestId }] }; c.session = null; return; }
        c.st = { screen: p.to, provider: p.provider, stack: [...(c.st.stack || []), { screen: c.st.screen, sessionId: c.st.sessionId, requestId: c.st.requestId, provider: c.st.provider }] };
        if (p.to === "needs" || p.to === "working") { const h = await home(true).catch(() => null); if (h) speak(c, listSummary(h, p.to)); }
        return;
      }
      case "next": toast("Heard: next"); return triageNext(c);
      case "read": {
        if (p.sessionId) { const text = String(latest[p.sessionId] || lastAssistant(c.session) || "").replace(/\s+/g, " ").slice(0, 400); return speak(c, text || "Nothing to read yet.", providerOf(p.sessionId)); }
        const h = await home(true).catch(() => null); return speak(c, h ? listSummary(h, "needs") : "I can't reach the Mac right now.");
      }
      case "speech": setSpeech(p.on); toast(`Speech ${p.on ? "on" : "off"}`); if (p.on) speak(c, "Speech on"); return;
      case "health": {
        toast("Checking...");
        if (!walking(c)) { c.st = { screen: "health", stack: [...(c.st.stack || []), { screen: c.st.screen, sessionId: c.st.sessionId, requestId: c.st.requestId, provider: c.st.provider }] }; paint(c, true).catch(() => {}); }
        return speak(c, healthSummary(await refreshHealth()));
      }
      case "help":
        toast("Heard: help");
        if (!walking(c)) c.st = { screen: "help", stack: [...(c.st.stack || []), { screen: c.st.screen, sessionId: c.st.sessionId, requestId: c.st.requestId, provider: c.st.provider }] };
        return speak(c, "Hold and speak. Say: what needs me, next, approve, go to Cowork, open a session by name, stop, read it, or just ask a question from home. Say walking mode for big text.");
      case "confirm": case "cancelConfirm": {
        const card = c.st.screen === "voiceConfirm" ? c.st : null; const s2 = [...((card && card.stack) || [])]; const prev = s2.pop() || { screen: "home" };
        if (!card) return toast("Nothing to confirm");
        c.st = { ...prev, stack: s2 };
        if (p.action === "cancelConfirm") { toast("Cancelled"); return speak(c, "Cancelled."); }
        return runVoice(c, card.voice.proposal);
      }
      case "freetalk":
        setFree(p.on); toast(p.on ? "◉ Free talk on" : "Push to talk");
        return speak(c, p.on ? "Free talk on. Commands work directly. Start questions with: Glasses." : "Push to talk.");
      case "walkmode": c.walkOverride = p.on === "auto" ? null : p.on; c.walk = { mode: "glance" };
        send(c, { type: "imu", on: c.walkOverride == null });   // motion sensor only needed for automatic detection
        speak(c, p.on === "auto" ? "Walking mode is automatic" : p.on ? "Walking mode on" : "Walking mode off"); return;
      case "approve": await agentd.request("approve", { requestId: p.requestId, client: CLIENT }); say("Approved"); return triageAdvance(c);
      case "deny": await agentd.request("deny", { requestId: p.requestId, client: CLIENT }); say("Denied"); return triageAdvance(c);
      case "answer": await agentd.request("answer", { requestId: p.requestId, answer: p.answer, client: CLIENT }); say(`Answered ${p.answer}`); return triageAdvance(c);
      case "stop": await agentd.request("interrupt", { sessionId: p.sessionId, client: CLIENT }); return say("Stop sent");
      case "send": await agentd.request("send", { sessionId: p.sessionId, message: p.message, client: CLIENT, detach: true }); return say("Sent");
      case "create": {
        say(p.provider === "chatgpt" ? "Asking ChatGPT" : "Starting a new Cowork task");
        const r = await agentd.request("create", { provider: p.provider, firstMessage: p.firstMessage, project: p.project, client: CLIENT });
        c.st = { screen: "session", sessionId: r.sessionId, stack: [{ screen: "home" }] }; c.session = null; homeAt = 0; watch(r.sessionId);
        return say(p.provider === "chatgpt" ? "Sent. I'll read the answer when it's ready." : "Task started");
      }
    }
  }
  // Spoken output (to the phone → AirPods). One utterance at a time per connection; newest wins over a backlog.
  // `who` = provider whose voice to use (one voice per harness, voice/config.json); default "system".
  const providerOf = (sid) => String(sid || "").split(":")[0] || "system";
  async function speak(c, text, who = "system", method) {
    if (!text || !c.ready || c.speech === false) return;
    if (c.hidden && push && push.count()) {   // phone locked: audio would be muted → notification (Siri can announce it)
      const key = `${who}|${text}`; if (c.lastPushed === key) return; c.lastPushed = key;
      return push.notify({ title: who === "system" ? "Command Center" : providerLabel(who), body: String(text).slice(0, 280), tag: `say-${who}` }).catch(() => {});
    }
    c.speakQ = (c.speakQ || []).slice(-2); c.speakQ.push({ t: String(text).slice(0, 400), who, method });
    if (c.speaking) return; c.speaking = true;
    try {
      while (c.speakQ.length) {
        const { t, who: w, method } = c.speakQ.shift();
        try { const r = await voice("/tts", JSON.stringify({ text: t, provider: w }), { "Content-Type": "application/json" }); send(c, { type: "audio", mime: "audio/wav", b64: Buffer.from(await r.arrayBuffer()).toString("base64"), text: t, voice: w, method }); }
        catch (e) { log("g2 tts error", e.message); }
      }
    } finally { c.speaking = false; }
  }
  function listSummary(h, which) {
    if (which === "working") return h.working.length ? `${h.working.length} working: ${h.working.slice(0, 3).map((w) => `${providerLabel(w.provider)}, ${w.title}`).join("; ")}.` : "Nothing is running.";
    const n = h.needsYou.length; if (!n) return "Nothing needs you.";
    const parts = h.needsYou.slice(0, 3).map((x) => `${providerLabel(x.provider)} ${x.kind === "approval" ? "wants approval" : x.kind === "question" ? "asks a question" : x.kind === "input" ? "is waiting for your input" : x.kind === "failure" ? "failed" : "finished"}: ${x.title}`);
    return `${n === 1 ? "One thing" : `${n} things`}. ${parts.join(". ")}.${n > 1 ? " Say next to go through them." : ""}`;
  }
  function spokenFor(ev) {
    const who = providerLabel(ev.provider);
    if (ev.type === "approval.requested") return `${who} needs your approval: ${ev.request && ev.request.description || "a request"}.`;
    if (ev.type === "question.requested") { const q = ev.request && ev.request.question && ev.request.question[0]; return `${who} asks: ${q ? q.text : ev.request && ev.request.description}${q && q.options && q.options.length ? `. Options: ${q.options.slice(0, 4).join(", ")}.` : ""}`; }
    return null;
  }

  // Event-driven refresh: only for connections whose screen is affected; coalesced per connection.
  agentd.on("event", (ev) => {
    if (ev.type === "agent.output.delta" && !ev.snapshot) latest[ev.sessionId] = (latest[ev.sessionId] || "") + (ev.text || "");
    else if (ev.type === "agent.output.delta" && ev.snapshot) latest[ev.sessionId] = ev.text || "";
    else if (ev.type === "agent.output.complete") latest[ev.sessionId] = ev.text || latest[ev.sessionId];
    else if (ev.type === "agent.started") latest[ev.sessionId] = "";
    if (/^(approval|question|agent\.(started|completed|failed|interrupted)|status\.changed|sessions\.changed)/.test(ev.type)) homeAt = 0;
    const say = speakEvents && spokenFor(ev);
    if (push) {
      const who = providerLabel(ev.provider);
      if (ev.type === "approval.requested" || ev.type === "question.requested") push.notify({ title: `${who} ${ev.type === "question.requested" ? "asks" : "needs your approval"}`, body: spokenFor(ev), tag: ev.sessionId }).catch(() => {});
      if ((ev.type === "agent.completed" || ev.type === "agent.failed") && (watched.get(ev.sessionId) || 0) > Date.now())
        push.notify({ title: `${who} ${ev.type === "agent.failed" ? "failed" : "answered"}`, body: String(latest[ev.sessionId] || ev.result || ev.error || "").replace(/\s+/g, " ").slice(0, 280), tag: ev.sessionId }).catch(() => {});
    }
    for (const c of conns) {
      if (say && c.ready) speak(c, say, ev.provider);
      if (speakEvents && c.ready && ev.type === "agent.completed" && (c.st.sessionId === ev.sessionId || (walking(c) && (watched.get(ev.sessionId) || 0) > Date.now()))) {
        const answer = String(latest[ev.sessionId] || ev.result || "").replace(/\s+/g, " ").trim();
        speak(c, `Done. ${answer.slice(0, 280)}`, ev.provider);
        if (walking(c)) startReading(c, ev.provider, answer.slice(0, 600));
      }
      const relevant = c.st.sessionId === ev.sessionId || ["home", "needs", "working", "sessions", "request", "actions"].includes(c.st.screen);
      if (!relevant || !c.ready) continue;
      schedulePaint(c);
    }
  });

  // Throttle: the BLE link to the glasses is slow and agents stream ~40 deltas/s. Repaint at most once per
  // MIN_PAINT_MS (leading + trailing), so the display stays current without queueing stale frames.
  const MIN_PAINT_MS = T.minPaintMs;
  function schedulePaint(c) {
    if (c.timer) return; // a paint is already scheduled; it will pick up the latest state
    const wait = Math.max(250, MIN_PAINT_MS - (Date.now() - (c.lastPaint || 0)));
    c.timer = setTimeout(() => { c.timer = null; c.lastPaint = Date.now(); paint(c).catch((e) => log("paint", e.message)); }, wait);
  }
  // Elapsed-time ticker for a working session (the "Working Ns" line), independent of output events.
  setInterval(() => {
    for (const c of conns) if (c.ready && c.st.screen === "session" && live[c.st.sessionId] && live[c.st.sessionId].status === "working") schedulePaint(c);
  }, 1000).unref();

  // With a certificate (Tailscale name), serve wss:// so the phone can connect over cellular through Tailscale.
  const httpsServer = tls ? https.createServer({ cert: tls.cert, key: tls.key }).listen(port, host) : null;
  // Pocket mode (Web Push to the home-screen web app), served on the same HTTPS origin.
  const push = httpsServer && runDir ? createPush({ runDir, token, log }) : null;
  if (httpsServer) httpsServer.on("request", async (req, res) => { if (!(push && (await push.handle(req, res)))) { res.writeHead(404); res.end(); } });
  // Remembered settings (survive reconnects/restarts): speech on/off.
  const prefsFile = runDir ? path.join(runDir, "g2-prefs.json") : null;
  // Every spoken command with what was on screen, what it became, and how long each stage took: the test set
  // for comparing interpreters (and later for fine-tuning). Local only, in run/.
  const writeEval = runDir ? appender(path.join(runDir, "voice-eval.jsonl")) : null;
  const prefs = (() => { try { return { free: false, ...JSON.parse(fs.readFileSync(prefsFile, "utf8")) }; } catch { return { speech: true, free: false }; } })();
  const savePrefs = () => { if (prefsFile) fs.writeFileSync(prefsFile, JSON.stringify(prefs)); };
  const setFree = (on) => { prefs.free = !!on; savePrefs(); for (const x of conns) { x.free = prefs.free; send(x, { type: "free", on: prefs.free }); } };
  const setSpeech = (on) => { prefs.speech = !!on; for (const x of conns) x.speech = prefs.speech; if (prefsFile) fs.writeFileSync(prefsFile, JSON.stringify(prefs)); };
  const watched = new Map(); // sessionId -> until (ms): sessions acted on from the glasses get their answer pushed
  const watch = (sid) => { if (sid) watched.set(sid, Date.now() + 2 * 3600e3); };
  const wss = new WebSocketServer({
    ...(httpsServer ? { server: httpsServer } : { host, port }),
    verifyClient: ({ origin }, cb) => (allowedOrigins.includes(origin) ? cb(true) : (log("g2 origin rejected", origin), cb(false, 403))),
  });
  // Always also accept plain ws on 127.0.0.1:(port+1) for the desktop simulator (local only, same auth), so the
  // simulator works the same whether or not a certificate is installed.
  const localWss = localPort === false ? null : new WebSocketServer({ host: "127.0.0.1", port: localPort ?? port + 1, verifyClient: ({ origin }, cb) => (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? cb(true) : cb(false, 403)) });
  const onConnection = (ws, req) => {
    const c = { ws, st: { screen: "home", stack: [] }, page: null, ready: false, remote: req.socket.remoteAddress, speech: prefs.speech, free: prefs.free };
    const authTimer = setTimeout(() => ws.close(4001, "auth timeout"), 5000);
    ws.on("message", (raw, isBinary) => onMessage(raw, isBinary).catch((e) => log("g2 message error", e.message)));
    const onMessage = async (raw, isBinary) => {
      if (isBinary) { if (c.ready) pttAudio(c, Buffer.from(raw)); return; }
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!c.ready) {
        const ok = m.type === "hello" && tokenEquals(m.token, token);
        if (!ok) { ws.close(4003, "bad token"); return; }
        clearTimeout(authTimer); c.ready = true; conns.add(c); log("g2 connected", c.remote, m.device || "");
        send(c, { type: "imu", on: c.walkOverride == null });   // sync the motion sensor with the mode after (re)connects
        send(c, { type: "free", on: !!c.free });                 // and free talk
        if (m.resume && m.resume.screen) c.st = { ...m.resume, stack: m.resume.stack || [] };
        try { await paint(c, true); } catch (e) { send(c, { type: "render", mode: "rebuild", page: render({ screen: "home" }, {}) }); }
        return;
      }
      if (m.type === "input") await onInput(c, m);
      if (m.type === "imu") return onImu(c, m);
      if (m.type === "visible") { c.hidden = !m.on; log("g2 phone", m.on ? "visible" : "hidden (locked/background)"); return; }
      if (m.type === "ptt" && m.state === "start") pttStart(c, !!m.auto).catch((e) => log("ptt", e.message));
      if (m.type === "ptt" && m.state === "end") pttEnd(c).catch((e) => { log("ptt", e.message); if (c.st.screen === "listening") { const s2 = [...(c.st.stack || [])]; const prev = s2.pop() || { screen: "home" }; c.st = { ...prev, stack: s2 }; } send(c, { type: "toast", text: "Something went wrong - try again" }); paint(c, true).catch(() => {}); });
      if (m.type === "ping") send(c, { type: "pong" });
      if (m.type === "log") log("g2 app", String(m.what || "").slice(0, 40), JSON.stringify(m).slice(0, 240));
    };
    ws.on("close", () => { conns.delete(c); clearTimeout(authTimer); clearTimeout(c.timer); });
  };
  wss.on("connection", onConnection);
  if (localWss) localWss.on("connection", onConnection);
  return { wss, localWss, conns, latest, walkMode: (on) => { for (const c of conns) { c.walkOverride = on; c.walk = { mode: "glance" }; paint(c, true).catch(() => {}); } return conns.size; },
    read: (who, text) => { for (const c of conns) startReading(c, who, text); return conns.size; },
    // Typed utterance (demo recordings, tests): the same path as speech, without the microphone.
    setFreeTalk: (on) => { setFree(!!on); return prefs.free; },
    hear: (text) => { for (const c of conns) if (c.ready) handleUtterance(c, { text: String(text), engine: "typed", ms: 0 }, { prev: c.st, screenCtx: screenContext(c.st, c.page), auto: false, t0: Date.now(), tRelease: Date.now() }).catch((e) => log("hear", e.message)); return conns.size; },
    speakAll: (text, who, method) => { for (const c of conns) speak(c, text, who, method); return conns.size; } };
}

/** Latest exchange for the session view: the previous agent reply and the user's last message (newest last). */
function lastExchange(s) {
  const msgs = (s && s.messages || []).filter((m) => m.text && (m.role === "user" || m.role === "assistant"));
  if (!msgs.length) return "";
  const lastUser = [...msgs].reverse().find((m) => m.role === "user"), lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
  const label = (m) => (m.role === "user" ? "You: " : "");
  const ordered = [lastAsst, lastUser].filter(Boolean).sort((a, b) => msgs.indexOf(a) - msgs.indexOf(b));
  return ordered.map((m) => label(m) + m.text.replace(/\s+/g, " ").trim()).join("\n\n");
}
function lastAssistant(s) { const m = (s && s.messages || []).filter((x) => x.role === "assistant" && x.text).pop(); return m ? m.text : ""; }
