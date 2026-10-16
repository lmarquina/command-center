// G2 screen state machine (server-side; the glasses app is a thin renderer).
// Pure: state + data in → { page, actions } out. Page = Even Hub containers within G2 limits.
// Limits (Even Hub docs/SDK 0.0.16): canvas 576x288; ≤8 non-image containers; list ≤20 items, item ≤63 bytes;
// text ≤1000 chars at rebuild (≈400–500 visible); ≤4 image containers (≤288x144, PNG → 4-bit green).
// The firmware font drops unknown glyphs, so text is filtered to the glyph set the font supports (Latin-1, arrows,
// box drawing, blocks, ●○■□▲▶★…; see even-g2-notes docs/display.md).
import { providerLabel } from "./viewModel.mjs";

export const W = 576, H = 288;
const MAX_ITEMS = 20, ITEM_BYTES = 63, BODY_CHARS = 230; // ~230 chars fit below the status line on hardware/simulator

// Glyphs the G2 font renders (others are silently dropped by the firmware, so we drop them first, predictably).
const FONT = /[^\n\x20-\x7E\u00A0-\u00A7\u00A9-\u00AE\u00B0-\u00B3\u00B6\u00B7\u00B9-\u00FF\u2190-\u2199\u21D2\u21D4\u2500-\u2573\u2581-\u258F\u2592\u2594\u2595\u25A0\u25A1\u25A3-\u25A9\u25B2\u25B3\u25B6\u25B7\u25BC\u25BD\u25C0\u25C1\u25C6-\u25C8\u25CA\u25CB\u25CC\u25CE\u25CF\u25D0\u25D1\u25E2-\u25E5\u25EF\u2605\u2606\u2609\u260E\u260F\u261C\u261E\u2660\u2661\u2663\u2664\u2665\u2667\u2122\u2020\u203B\u221E\u2070\u2074-\u2079\u2080-\u2089\u215B]/g;
export function ascii(s) {
  return String(s ?? "").normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[•∙]/g, "·").replace(FONT, "");
}
/** Truncate to n UTF-8 bytes (glyphs like ● are 3 bytes; list items are limited to ~63 bytes). */
export function fitBytes(s, n = ITEM_BYTES) {
  let t = ascii(s).replace(/[\t\r\n]+/g, " ").replace(/ {5,}/g, "    ").trim(); const enc = new TextEncoder();   // keep ≤4-space gaps (column spacing)
  if (enc.encode(t).length <= n) return t;
  while (t && enc.encode(t + "...").length > n) t = t.slice(0, -1);
  return t.trimEnd() + "...";
}
// One visual vocabulary everywhere.
export const G = { need: "●", working: "▶", idle: "○", stopped: "■", done: "★", failed: "▲", go: "▷", back: "◁", more: "▼", prev: "▲" };
const glyphFor = (x, needIds, live) => needIds && needIds.has(x.sessionId) ? G.need : (x.status === "working" || (live && live[x.sessionId] && live[x.sessionId].status === "working")) ? G.working : x.status === "interrupted" ? G.stopped : x.status === "failed" ? G.failed : x.status === "complete" ? G.done : G.idle;
/** Elapsed-time bar: 6 cells, full at 30 min. */
export function bar(sec, cells = 6, fullAt = 1800) { const n = Math.max(1, Math.min(cells, Math.round(((sec || 0) / fullAt) * cells))); return "━".repeat(n) + "─".repeat(cells - n); }
const dur = (sec) => (sec == null ? "" : sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m`);
const STATUS_WORD = { working: "Working", approval_required: "Needs approval", waiting_for_input: "Question", complete: "Done", interrupted: "Stopped", failed: "Failed", idle: "Idle", unknown: "" };

// ---------- page builders (containers use SDK field names) ----------
function header(text, icon) {
  // optional 48x48 harness/alert icon at top-left (image container; PNG from the app's /icons)
  const x = icon ? 56 : 0;
  const hdr = { kind: "text", containerID: 1, containerName: "hdr", xPosition: x, yPosition: 0, width: W - x, height: icon ? 50 : 44, isEventCapture: 0, content: fitBytes(text, 120), textColor: 4 };
  return icon ? [hdr, { kind: "image", containerID: 9, containerName: "icon", xPosition: 0, yPosition: 0, width: 48, height: 48, src: `icons/${icon}.png` }] : [hdr];
}
function list(items, top = 48) {
  const names = items.slice(0, MAX_ITEMS).map((i) => fitBytes(i.label));
  return { kind: "list", containerID: 2, containerName: "list", xPosition: 0, yPosition: top, width: W, height: H - top, isEventCapture: 1, itemContainer: { itemCount: names.length, itemWidth: W - 8, isItemSelectBorderEn: 1, itemName: names } };
}
function body(text, top = 48, capture = 1, id = 2, extra = {}) { return { kind: "text", containerID: id, containerName: id === 2 ? "body" : id === 3 ? "info" : `t${id}`, xPosition: 0, yPosition: top, width: W, height: H - top, isEventCapture: capture, content: ascii(text).slice(0, 990), ...extra }; }
const dim = (text, top, height, id = 5) => ({ kind: "text", containerID: id, containerName: `dim${id}`, xPosition: 0, yPosition: top, width: W, height, isEventCapture: 0, content: fitBytes(text, 200), textColor: 2 });
const card = (text, top, height, id = 3) => ({ kind: "text", containerID: id, containerName: "info", xPosition: 4, yPosition: top, width: W - 8, height, isEventCapture: 0, content: ascii(text).slice(0, 400), borderWidth: 2, borderColor: 12, borderRadius: 8, paddingLength: 6, textColor: 4 });
const page = (screen, containers, items = []) => ({ screen, containers, items }); // items: actions behind list rows, same order

/**
 * @param {object} st   navigation state {screen, sessionId?, requestId?, offset?}
 * @param {object} d    data {home (buildHome output), session?, live?, latestText?, requests?}
 */
export function render(st, d) {
  const home = d.home || { counts: { needsYou: 0, working: 0 }, needsYou: [], working: [], recent: [] };
  switch (st.screen) {
    case "home": {
      // Command center: the 3 most recent sessions across all harnesses, then the lists. Markers: ! needs you, * working.
      const needIds = new Set(home.needsYou.filter((x) => x.kind === "approval" || x.kind === "question" || x.kind === "input").map((x) => x.sessionId));
      const seen = new Set(), all = [];
      for (const x of [...home.needsYou, ...home.working, ...home.recent]) if (x.sessionId && !seen.has(x.sessionId)) { seen.add(x.sessionId); all.push(x); }
      // top rows: what needs you, then what's running, then the most recent (undated rows can't outrank live work)
      const rank = (x) => (needIds.has(x.sessionId) ? 0 : (x.status === "working" || (d.live && d.live[x.sessionId] && d.live[x.sessionId].status === "working")) ? 1 : 2);
      const last3 = recentFirst(all, d.live).sort((a, b) => rank(a) - rank(b)).slice(0, 3).map((x) => ({ label: `${glyphFor(x, needIds, d.live)} ${shortProvider(x.provider)}  ${x.title || ""}`, action: { go: "session", sessionId: x.sessionId } }));
      const everything = d.allSessions || [];
      const per = (p) => everything.filter((x) => x.provider === p).length;
      const harnesses = ["cowork", "claude-code", "codex", "chatgpt"].filter((p) => per(p)).map((p) => ({ label: `${G.go} ${providerLabel(p)}  ${per(p)}`, action: { go: "sessions", provider: p } }));
      // A failing system check gets one row at the top; the full list is on the system-check screen.
      const problems = (d.health || []).filter((x) => !x.ok);
      const warn = problems.length ? [{ label: `${G.failed} ${problems[0].label}${problems.length > 1 ? `  +${problems.length - 1}` : ""}`, action: { go: "health" } }] : [];
      const items = [
        ...warn,
        ...last3,
        { label: `${G.need} Needs you  ${home.counts.needsYou}`, action: { go: "needs" } },
        { label: `${G.working} Working  ${home.counts.working}`, action: { go: "working" } },
        ...harnesses,
        { label: `${G.go} All sessions${everything.length ? `  ${everything.length}` : ""}`, action: { go: "sessions" } },
        { label: `${d.speech === false ? "○" : "●"} Speech ${d.speech === false ? "off" : "on"}`, action: { speech: d.speech === false } },
      ];
      return page("home", [...header(`COMMAND CENTER    ${G.need} ${home.counts.needsYou}    ${G.working} ${home.counts.working}${d.speech === false ? "    ○ muted" : ""}${d.free ? "    ◉ free talk" : ""}`), list(items)], items);
    }
    case "needs": {
      const items = home.needsYou.slice(0, MAX_ITEMS - 1).map((n) => ({ label: `${n.kind === "approval" || n.kind === "question" || n.kind === "input" ? G.need : n.kind === "failure" ? G.failed : G.done} ${shortProvider(n.provider)}  ${n.kind === "approval" ? "approve? " : n.kind === "question" ? "asks: " : n.kind === "input" ? "waiting: " : ""}${n.title}`, action: n.requestId ? { go: "request", requestId: n.requestId, sessionId: n.sessionId } : { go: "session", sessionId: n.sessionId } }));
      items.push({ label: `${G.back} Back`, action: { back: true } });
      return page("needs", [...header(home.needsYou.length ? `NEEDS YOU   ${G.need} ${home.needsYou.length}` : "ALL CLEAR - nothing needs you", home.needsYou.some((n) => n.requestId) ? "alert" : null), list(items, home.needsYou.some((n) => n.requestId) ? 54 : 48)], items);
    }
    case "working": case "sessions": {
      // "sessions" may be filtered to one harness ("go to cowork"): needs-you and working first, then recent.
      // each list gets its own "seen" set: sharing one dropped every session already in the home summary from the
      // harness list (an empty Cowork list when all its sessions were recent)
      const dedupe = (rows) => { const seen = new Set(); return rows.filter((x) => x.sessionId && !seen.has(x.sessionId) && seen.add(x.sessionId)); };
      const pool = st.screen === "working" ? home.working : dedupe([...home.needsYou, ...home.working, ...home.recent]);
      // a harness list uses the FULL session list (needs-you / working first), not the ~25-item home summary
      const full = st.provider && d.allSessions && d.allSessions.length ? dedupe([...pool, ...d.allSessions]) : pool;
      const src = st.provider ? full.filter((x) => x.provider === st.provider) : pool;
      if (st.screen === "sessions" && !st.provider && d.allSessions && d.allSessions.length) return render({ ...st, provider: "*" }, d);
      if (st.provider === "*") return pagedSessions(st, home, full, "ALL SESSIONS", true);
      if (st.provider && st.screen === "sessions") {
        return pagedSessions(st, home, src, providerLabel(st.provider).toUpperCase(), false);
      }
      const items = src.slice(0, MAX_ITEMS - 1).map((s) => ({ label: `${G.working} ${bar(s.forSeconds)} ${dur(s.forSeconds) || ""}  ${shortProvider(s.provider)}  ${s.title}`, action: { go: "session", sessionId: s.sessionId } }));
      items.push({ label: `${G.back} Back`, action: { back: true } });
      return page(st.screen, [...header(st.screen === "working" ? `WORKING   ${G.working} ${home.working.length}` : "SESSIONS"), list(items)], items);
    }
    case "session": {
      const s = d.session || {}; const status = (d.live && d.live.status) || s.status;
      const since = d.live && d.live.since && status === "working" ? ` ${dur(Math.round((Date.now() - Date.parse(d.live.since)) / 1000))}` : "";
      const text = sessionBody(d.latestText, st.offset || 0);
      const pending = (d.requests || []).filter((r) => r.sessionId === st.sessionId);
      const hint = pending.length ? "tap: respond · hold: talk" : "tap: menu · hold: talk";
      const g = pending.length ? G.need : status === "working" ? G.working : status === "interrupted" ? G.stopped : status === "failed" ? G.failed : status === "complete" ? G.done : G.idle;
      const prov = s.provider || String(st.sessionId || "").split(":")[0];
      return page("session", [...header(s.title || st.sessionId, prov), dim(`${g} ${STATUS_WORD[status] || status || ""}${since}${status === "working" && d.live && d.live.since ? "  " + bar((Date.now() - Date.parse(d.live.since)) / 1000) : ""}${pending.length ? `   ${G.need} ${pending.length} need you` : ""}      ${hint}`, 50, 28), body(text, 80)]);
    }
    case "actions": {
      const s = d.session || {}; const caps = s.capabilities || {};
      const pending = (d.requests || []).filter((r) => r.sessionId === st.sessionId);
      const steps = stepsFrom(s);
      const items = [
        ...pending.map((r) => ({ label: `${G.need} ${r.kind === "question" ? "Answer" : "Approve?"}: ${r.text || ""}`, action: { go: "request", requestId: r.requestId, sessionId: st.sessionId } })),
        ...(steps.length ? [{ label: `${G.go} Steps  ${steps.length}`, action: { go: "steps", sessionId: st.sessionId } }] : []),
        ...(caps.canInterrupt ? [{ label: `${G.stopped} Stop`, action: { go: "confirmStop", sessionId: st.sessionId } }] : []),
        { label: d.speech === false ? "○ Speech off  · tap to turn on" : "● Speech on  · tap to mute", action: { speech: d.speech === false } },
        { label: d.free ? "◉ Free talk on  · tap for push-to-talk" : "○ Free talk off  · tap to turn on", action: { free: !d.free } },
        { label: "◎ Refresh", action: { refresh: true } },
        { label: `${G.back} Back`, action: { back: true } },
      ];
      return page("actions", [...header(`ACTIONS - ${s.title || ""}`), list(items)], items);
    }
    case "request": {
      const r = (d.requests || []).find((x) => x.requestId === st.requestId);
      if (!r) return page("request", [...header("REQUEST RESOLVED"), list([{ label: `${G.back} Back` }])], [{ label: `${G.back} Back`, action: { back: true } }]);
      const items = r.kind === "question"
        ? [...(r.options || []).slice(0, 8).map((o, i) => ({ label: `${String.fromCharCode(65 + i)}  ${o}`, action: { answer: o, requestId: r.requestId } })), { label: `${G.back} Back`, action: { back: true } }]
        : [{ label: "● Approve", action: { approve: r.requestId } }, { label: "○ Deny", action: { deny: r.requestId } }, { label: `${G.back} Back`, action: { back: true } }];
      const title = `${providerLabel(r.provider)} ${r.kind === "question" ? "asks" : "needs your approval"}`;
      return page("request", [...header(title, r.kind === "question" ? "question" : "alert"), card(fitBytes(r.text, 180), 54, 84), list(items, 144)], items);
    }
    case "confirmStop": {
      const items = [{ label: `${G.stopped} Stop now`, action: { stop: st.sessionId } }, { label: `${G.back} Cancel`, action: { back: true } }];
      return page("confirmStop", [...header("STOP THIS TASK?", "alert"), list(items, 54)], items);
    }
    case "steps": {
      const steps = stepsFrom(d.session);
      const items = [...steps.slice(-(MAX_ITEMS - 1)).map((x, i, arr) => ({ label: `${x.group ? "▶ " : "· "}${x.label}`, action: { go: x.group ? "substeps" : "step", sessionId: st.sessionId, index: steps.length - arr.length + i } })), { label: `${G.back} Back`, action: { back: true } }];
      return page("steps", [...header(`STEPS (${steps.length}) - ${(d.session && d.session.title) || ""}`), list(items)], items);
    }
    case "step": {
      const steps = stepsFrom(d.session); const x = steps[st.index] || { label: "Step not available", detail: "" };
      return page("step", [...header(`STEP ${(st.index ?? 0) + 1}/${steps.length}`), body(`${pageText(x.detail || x.label, st.offset || 0)}\n(swipe: more  2x: back)`)]);
    }
    case "substeps": {   // inside a Cowork step group (read on demand through the bridge)
      const sub = d.substeps;
      if (!sub) return page("substeps", [...header("OPENING STEP GROUP..."), body("Reading the steps from claude.ai...", 48, 1)]);
      if (sub.error) { const items = [{ label: `${G.back} Back`, action: { back: true } }]; return page("substeps", [...header("COULDN'T OPEN"), body(fitBytes(sub.error, 180), 44, 0, 3), list(items, 140)], items); }
      const rows = sub.steps.slice(-(MAX_ITEMS - 1));
      const items = [...rows.map((x) => ({ label: `${x.openable ? "▷ " : "· "}${x.text}`, action: { go: "stepdetail", sessionId: st.sessionId, index: st.index, stepKey: x.key, stepText: x.text, openable: x.openable } })), { label: `${G.back} Back`, action: { back: true } }];
      return page("substeps", [...header(`${sub.steps.length} STEPS - ${sub.label || ""}`), list(items)], items);
    }
    case "stepdetail": {
      const det = d.stepDetail;
      const text = !st.openable ? st.stepText : !det ? "Opening..." : det.error ? `Couldn't open: ${det.error}` : (det.text || st.stepText || "(no details)");
      return page("stepdetail", [...header(fitBytes(st.stepText || "STEP", 120)), body(`${pageText(text, st.offset || 0)}\n(swipe: more  2x: back)`)]);
    }
    case "choose": {
      const v = st.voice || {}; const opts = (v.proposal && v.proposal.options) || [];
      const items = [...opts.slice(0, 5).map((o) => ({ label: o.label, action: { voice: o.proposal } })), { label: "Cancel", action: { back: true } }];
      return page("choose", [...header("DID YOU MEAN?"), card(fitBytes(`"${v.transcript || ""}"`, 180), 46, 50), list(items, 100)], items);
    }
    case "health": {   // system check: one row per moving part
      const checks = d.health || [];
      const bad = checks.filter((x) => !x.ok).length;
      const items = [...checks.map((x) => ({ label: `${x.ok ? G.done : G.failed} ${x.label}`, action: {} })), { label: `${G.back} Back`, action: { back: true } }];
      const head = !checks.length ? "SYSTEM CHECK - checking..." : bad ? `SYSTEM CHECK   ${G.failed} ${bad} problem${bad > 1 ? "s" : ""}` : "SYSTEM CHECK - all good";
      return page("health", [...header(head, bad ? "alert" : null), list(items)], items);
    }
    case "help": {   // every voice command; rows with a target can also be tapped
      const H = [
        [`${G.need} "what needs me"  · waiting items`, { go: "needs" }], [`${G.working} "what's running"  · working`, { go: "working" }],
        [`${G.need} "next"  · go through them one by one`, null], [`${G.need} "approve" / "deny" / "option B"`, null],
        [`${G.go} "go to Cowork" (Codex, Claude, ChatGPT)`, null], [`${G.go} "open <a few title words>"`, null],
        [`◎ Home: ask anything  · goes to ChatGPT`, null], [`◎ In a session: just talk  · sends it`, null],
        [`${G.working} "new task in <project>: ..."`, null], [`${G.stopped} "stop"  · in a session`, null],
        [`${G.go} "read it"  · read aloud`, null], [`○ "be quiet" / "speech on"`, null],
        [`${G.working} "walking mode" / "normal mode" / "automatic"`, null], [`◉ "free talk" / "push to talk"  · hands-free`, null],
        [`◉ In free talk: "Glasses, <question>"`, null], [`${G.back} "home" / "back"`, null], [`${G.done} "system check"  · is everything connected`, { go: "health" }], [`? "help"  · this list`, null],
      ];
      const items = [...H.map(([label, go]) => ({ label, action: go || {} })), { label: `${G.back} Back`, action: { back: true } }];
      return page("help", [...header("VOICE COMMANDS   hold + speak", "mic"), list(items, 54)], items);
    }
    case "listening": return page("listening", [...header("LISTENING", "mic"), { ...body(st.level || "▁▁▁▁▁▁▁▁▁▁▁▁", 60, 0, 4), containerName: "level", height: 44, textColor: 4 }, body(`${st.note || "Speak now. Release to finish."}`, 110, 1, 2, { textColor: 3 })]);
    case "voiceConfirm": {
      const v = st.voice || {}; const p = v.proposal || {};
      if (p.action === "none") {
        const items = [{ label: "◎ Try again (hold)", action: { back: true } }, { label: `${G.back} Back`, action: { back: true } }];
        return page("voiceConfirm", [...header("DIDN'T CATCH THAT", "question"), card(fitBytes(`"${v.transcript || ""}"\n${p.reason || ""}`, 200), 54, 84), list(items, 144)], items);
      }
      const items = [{ label: "● Do it", action: { voice: p } }, { label: `${G.back} Cancel`, action: { back: true } }];
      const icon = p.action === "create" ? p.provider : p.action === "send" || p.action === "stop" ? String(p.sessionId || "").split(":")[0] : p.action === "answer" ? "question" : "alert";
      return page("voiceConfirm", [...header(fitBytes(describeVoice(p, d), 120), icon), card(fitBytes(`"${v.transcript || ""}"`, 200), 54, 84), list(items, 144)], items);
    }
    default: return render({ screen: "home" }, d);
  }
}

/** One-line description of a proposed voice action, shown as the confirm screen header. */
export function describeVoice(p, d = {}) {
  const reqs = d.requests || [];
  const who = (sid) => { const r = reqs.find((x) => x.sessionId === sid); return providerLabel((r && r.provider) || String(sid || "").split(":")[0]); };
  switch (p.action) {
    case "approve": return `APPROVE ${who(p.sessionId)}?`;
    case "deny": return `DENY ${who(p.sessionId)}?`;
    case "answer": return `ANSWER: ${p.answer}?`;
    case "stop": return "STOP THIS TASK?";
    case "send": return "SEND TO THIS SESSION?";
    case "create": return p.provider === "chatgpt" ? "ASK CHATGPT?" : `NEW COWORK TASK${p.project ? ` IN ${p.project}` : ""}?`;
    default: return "?";
  }
}

/** Steps of the latest turn that has any (tool calls, commands, reasoning lines). Each: {label, detail}. */
export function stepsFrom(session) {
  const msgs = (session && session.messages) || [];
  const turns = []; let cur = [];
  for (const m of msgs) { if (m.role === "user") { if (cur.length) turns.push(cur); cur = []; } else cur.push(m); }
  if (cur.length) turns.push(cur);
  for (let i = turns.length - 1; i >= 0; i--) { const st = turns[i].flatMap(stepOf); if (st.length) return st; }
  return [];
}
function stepOf(m) {
  const base = (p) => String(p || "").split("/").pop();
  if (Array.isArray(m.tools) && m.tools.length) return m.tools.map((t, i) => ({ label: String(t), group: !m.toolGroups || m.toolGroups[i] ? { turnKey: m.id, index: i } : null, detail: String(t) }));
  if (!m.tool) return [];
  const t = m.tool, inp = t.input || {}, r = m.toolResult || {};
  if (t.name === "commandExecution" || inp.command) {
    const cmd = String(inp.command || "").replace(/^\/bin\/zsh -lc '(.*)'$/, "$1");
    const ok = r.status ? ` (${r.status}${r.exitCode != null ? `, exit ${r.exitCode}` : ""})` : "";
    return [{ label: `Ran: ${cmd}`, detail: `Command: ${cmd}\nFolder: ${inp.cwd || "-"}${ok ? `\nResult:${ok}` : ""}${r.preview ? `\n\n${r.preview}` : ""}` }];
  }
  const target = inp.file_path || inp.path || inp.pattern || inp.url || inp.query || "";
  const extra = Object.entries(inp).filter(([k]) => !["file_path", "path"].includes(k)).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  return [{ label: `${t.name}: ${base(target) || ""}`.trim(), detail: `${t.name}${target ? `\n${target}` : ""}${extra ? `\n\n${extra}` : ""}${r.preview ? `\n\nResult:\n${r.preview}` : ""}` }];
}

/** A paged session list (More / Previous), ≤20 items. withHarness: prefix each row with its harness. */
function pagedSessions(st, home, src, title, withHarness) {
  const PER = MAX_ITEMS - 2, pg = st.page || 0, from = pg * PER, shown = src.slice(from, from + PER);   // room for More + Back
  const needIds = new Set(home.needsYou.filter((n) => n.requestId).map((n) => n.sessionId));
  const items = shown.map((x) => ({ label: `${glyphFor(x, needIds)} ${withHarness ? shortProvider(x.provider) + "  " : ""}${x.title || x.sessionId}`, action: { go: "session", sessionId: x.sessionId } }));
  if (from + PER < src.length) items.push({ label: `${G.more} More  ${src.length - from - PER}`, action: { page: pg + 1 } });
  items.push({ label: pg ? `${G.prev} Previous` : `${G.back} Back`, action: pg ? { page: pg - 1 } : { back: true } });
  const pages = Math.max(1, Math.ceil(src.length / PER));
  return page("sessions", [...header(`${title}  ${src.length}${pages > 1 ? `    ${pg + 1}/${pages}` : ""}`), list(items)], items);
}

const SHORT = { "claude-code": "Claude", codex: "Codex", cowork: "Cowork", chatgpt: "ChatGPT" };
export const shortProvider = (p) => SHORT[p] || providerLabel(p);
function recentFirst(rows, live = {}) {
  const at = (x) => String((live[x.sessionId] || {}).at || x.updatedAt || x.at || "");
  return [...rows].sort((a, b) => at(b).localeCompare(at(a)));
}

/** Page long text from the START (step details read top-down); swipe down = next page. */
export function pageText(text, offset = 0, size = 360) {
  const t = ascii(text || "").trim(); const start = Math.min(offset * size, Math.max(0, t.length - 1));
  return (start > 0 ? "..." : "") + t.slice(start, start + size) + (start + size < t.length ? "..." : "");
}

export function sessionBody(text, offset = 0) {
  const t = ascii(text || "(no output yet)").trim();
  // show the newest window; scrolling up moves back in steps of one window
  const end = Math.max(0, t.length - offset * BODY_CHARS);
  const start = Math.max(0, end - BODY_CHARS);
  return (start > 0 ? "..." : "") + t.slice(start, end);
}

/**
 * Input → state transition (+ side effect to perform via the unified layer).
 * @param {object} st current state (with .stack)
 * @param {object} pg last rendered page (items)
 * @param {{event:string, index?:number}} ev  event: click|double_click|up|down|long_press
 * @returns {{st, effect?}} effect: {approve|deny|answer|stop|refresh}
 */
export function reduce(st, pg, ev) {
  const push = (next) => ({ ...next, stack: [...(st.stack || []), { screen: st.screen, sessionId: st.sessionId, requestId: st.requestId, provider: st.provider, index: st.index }] });
  const pop = () => { const s = [...(st.stack || [])]; const prev = s.pop() || { screen: "home" }; return { ...prev, stack: s }; };
  if (ev.event === "double_click") return { st: pop() };
  if (st.screen === "session") {
    if (ev.event === "up") return { st: { ...st, offset: (st.offset || 0) + 1 } };
    if (ev.event === "down") return { st: { ...st, offset: Math.max(0, (st.offset || 0) - 1) } };
    if (ev.event === "click") return { st: push({ screen: "actions", sessionId: st.sessionId }) };
    return { st };
  }
  if (st.screen === "step" || st.screen === "stepdetail") {
    if (ev.event === "down") return { st: { ...st, offset: (st.offset || 0) + 1 } };
    if (ev.event === "up") return { st: { ...st, offset: Math.max(0, (st.offset || 0) - 1) } };
    return { st };
  }
  if (ev.event !== "click") return { st }; // lists scroll natively on the glasses
  const item = pg.items[ev.index ?? -1];
  if (!item || !item.action) return { st };
  const a = item.action;
  if (a.back) return { st: pop() };
  if (a.refresh) return { st, effect: { refresh: true } };
  if (a.go) return { st: push({ screen: a.go, sessionId: a.sessionId ?? st.sessionId, requestId: a.requestId, index: a.index, stepKey: a.stepKey, stepText: a.stepText, openable: a.openable, provider: a.provider }) };
  if (a.approve) return { st: pop(), effect: { approve: a.approve } };
  if (a.deny) return { st: pop(), effect: { deny: a.deny } };
  if (a.answer) return { st: pop(), effect: { answer: a.answer, requestId: a.requestId } };
  if (a.stop) { const s = pop(); return { st: s, effect: { stop: a.stop } }; }
  if (a.voice) { const s = pop(); return { st: s, effect: { voice: a.voice } }; }
  if (a.speech !== undefined) return { st, effect: { speech: a.speech } };
  if (a.free !== undefined) return { st, effect: { free: a.free } };
  if (a.page !== undefined) return { st: { ...st, page: a.page } };
  return { st };
}

/** Same layout (screen + container geometry + list items) → text-only upgrade is enough; else rebuild. */
export function needsRebuild(prev, next) {
  if (!prev || prev.screen !== next.screen) return true;
  const shape = (p) => JSON.stringify(p.containers.map((c) => [c.kind, c.containerID, c.xPosition, c.yPosition, c.height, c.kind === "list" ? c.itemContainer.itemName : c.kind === "image" ? c.src : null, c.borderWidth || 0]));
  return shape(prev) !== shape(next);
}
