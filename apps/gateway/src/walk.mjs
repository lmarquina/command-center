// Walking mode screens: big type rendered as images (the phone draws text on a canvas, cut into the 4 allowed
// 288x144 tiles = the whole 576x288 display). Few words, same place, large and bold: readable while the head bobs.
// Pure: (walk state, data) → page. A full-screen empty text container behind the tiles captures taps/swipes.
import { providerLabel } from "./viewModel.mjs";
import { G } from "./screens.mjs";

const TILES = [[0, 0], [288, 0], [0, 144], [288, 144]].map(([x, y], i) => ({ kind: "image", containerID: 9 + i, containerName: `tile${i}`, xPosition: x, yPosition: y, width: 288, height: 144, tile: i }));
const CAPTURE = { kind: "text", containerID: 1, containerName: "cap", xPosition: 0, yPosition: 0, width: 576, height: 288, isEventCapture: 1, content: " " };
const short = (p) => ({ "claude-code": "CLAUDE", codex: "CODEX", cowork: "COWORK", chatgpt: "CHATGPT" }[p] || String(p || "").toUpperCase());
const page = (screen, lines, extra = {}) => ({ screen, containers: [CAPTURE, ...TILES], items: [], big: { lines }, ...extra });
// line = { text, size (px), dim?: bool }
const L = (text, size, dim) => ({ text: String(text ?? ""), size, ...(dim ? { dim: true } : {}) });

/** Split text into reading chunks of ~3 words (≤ 22 chars), keeping punctuation pauses. */
export function chunks(text, maxWords = 3, maxChars = 22) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean); const out = []; let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= maxWords || [...cur, w].join(" ").length > maxChars)) { out.push(cur.join(" ")); cur = []; }
    cur.push(w); if (/[.!?;:]$/.test(w)) { out.push(cur.join(" ")); cur = []; }
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

/**
 * @param {object} w  walk state: {mode:"glance"|"request"|"read", requestId?, read?:{who, parts, i, paused}}
 * @param {object} st navigation state (listening / voiceConfirm / choose overlays render big too)
 * @param {object} d  data (home, requests, level?)
 */
export function renderWalk(w, st, d) {
  const home = d.home || { counts: { needsYou: 0, working: 0 }, needsYou: [], working: [] };
  if (st.screen === "listening") return page("w-listening", [L(`${G.need} LISTENING`, 44), L(st.level || "▁▁▁▁▁▁▁▁", 60), L("release when done", 24, true)]);
  if (st.screen === "voiceConfirm" || st.screen === "choose") {
    const v = st.voice || {}, p = v.proposal || {};
    if (p.action === "none" || st.screen === "choose") return page("w-confirm", [L("DIDN'T CATCH THAT", 38), L(`"${(v.transcript || "").slice(0, 40)}"`, 28, true), L("hold to try again   2×: back", 24, true)]);
    return page("w-confirm", [L(walkVerb(p, d), 40), L(`"${(v.transcript || "").slice(0, 44)}"`, 26, true), L(`tap: do it   2×: cancel`, 26)]);
  }
  if (w.mode === "read" && w.read) {
    const r = w.read, n = r.parts.length, bar = "━".repeat(Math.max(1, Math.round(((r.i + 1) / n) * 10))) + "─".repeat(10 - Math.max(1, Math.round(((r.i + 1) / n) * 10)));
    return page("w-read", [L(`${short(r.who)}${r.paused ? "  ■ paused" : ""}`, 26, true), L(r.parts[r.i] || "", 58), L(bar, 26, true)]);
  }
  if (w.mode === "request") {
    const r = (d.requests || []).find((x) => x.requestId === w.requestId);
    if (!r) return page("w-glance", glance(home, d));
    const opts = r.kind === "question" ? (r.options || []).slice(0, 3).map((o, i) => `${String.fromCharCode(65 + i)} ${o}`).join("  ") : "";
    return page("w-request", [L(`${short(r.provider)} ${r.kind === "question" ? "ASKS" : "NEEDS YOU"}`, 40), L((r.text || "").slice(0, 60), 28), L(r.kind === "question" ? opts.slice(0, 48) : "tap: approve…   hold: talk", 24, true)]);
  }
  return page("w-glance", glance(home, d));
}
function glance(home, d) {
  const top = home.needsYou.find((n) => n.requestId) || home.needsYou[0];
  const head = top ? `${short(top.provider)}: ${top.kind === "approval" ? "APPROVE?" : top.kind === "question" ? "QUESTION" : top.kind === "input" ? "WAITING" : top.kind === "failure" ? "FAILED" : "DONE"}` : home.counts.working ? `${home.counts.working} WORKING` : "ALL CLEAR";
  return [L(`${G.need} ${home.counts.needsYou}     ${G.working} ${home.counts.working}`, 72), L(head, 40), L(`${top ? "tap: next   hold: talk" : "hold: talk"}${d.speech === false ? "   ○ muted" : ""}`, 24, true)];
}
function walkVerb(p, d) {
  const who = (sid) => short(String(sid || "").split(":")[0]);
  switch (p.action) {
    case "approve": return `APPROVE ${who(p.sessionId)}?`;
    case "deny": return `DENY ${who(p.sessionId)}?`;
    case "answer": return `ANSWER ${String(p.answer).slice(0, 16)}?`;
    case "stop": return "STOP THE TASK?";
    case "send": return `SEND TO ${who(p.sessionId)}?`;
    case "create": return p.provider === "chatgpt" ? "ASK CHATGPT?" : "NEW COWORK TASK?";
    default: return "DO IT?";
  }
}
export const walkTitle = (p) => providerLabel(p);
