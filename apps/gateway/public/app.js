// Command Center UI. Talks ONLY to the gateway (/api/*), which maps 1:1 to the unified session layer.
// Provider differences are handled through the capabilities object, never by provider-name branches.
"use strict";
const TOKEN = document.querySelector('meta[name="cc-token"]').content;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let caps = {}; let view = { name: "home" }; let liveText = ""; let activity = [];

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { "X-CC-Token": TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || r.statusText), { code: j.error && j.error.code });
  return j;
}

// ---------- events (SSE) ----------
function connectEvents() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  es.addEventListener("agentd", (m) => { const s = JSON.parse(m.data); $("#conn").textContent = s.connected ? "agentd connected" : "agentd offline"; $("#conn").className = "conn " + (s.connected ? "ok" : "down"); });
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => { $("#conn").textContent = "reconnecting…"; $("#conn").className = "conn down"; };
}
let homeTimer = null;
function onEvent(ev) {
  if (view.name === "home") { clearTimeout(homeTimer); homeTimer = setTimeout(renderHome, 300); return; } // coalesce
  if (view.name !== "session" || ev.sessionId !== view.sessionId) return;
  if (ev.type === "agent.started") { liveText = ""; activity = []; }
  if (ev.type === "agent.output.delta" && !ev.snapshot) liveText += ev.text || "";
  if (ev.type === "agent.output.delta" && ev.snapshot) liveText = ev.text || "";
  if (ev.type === "agent.output.complete") liveText = ev.text || liveText;
  if (ev.type === "tool.started") activity.push(`▶ ${ev.tool} ${JSON.stringify(ev.details || {}).slice(0, 120)}`);
  if (ev.type === "tool.completed") activity.push(`${ev.isError ? "✗" : "✓"} ${ev.status || ""} ${(ev.preview || "").slice(0, 100)}`);
  if (ev.type === "status.changed") view.status = ev.status;
  const terminal = /^(agent\.(completed|interrupted|failed)|approval\.|question\.)/.test(ev.type);
  paintLive();
  if (terminal) setTimeout(() => openSession(view.sessionId, true), 400);
}

// ---------- home ----------
async function renderHome() {
  view = { name: "home" }; location.hash = "";
  const [h] = await Promise.all([api("GET", "/api/home"), Object.keys(caps).length ? null : api("GET", "/api/capabilities").then((c) => (caps = c)).catch(() => {})]);
  $("#counts").textContent = `${h.counts.needsYou} need you · ${h.counts.working} working`;
  const row = (x, badge) => `<div class="row" data-sid="${esc(x.sessionId)}"><span class="prov">${esc(x.providerLabel)}</span><span class="title">${esc(x.title)}</span><span class="badge ${esc(badge)}">${esc(label(badge, x))}</span></div>`;
  const needs = h.needsYou.length ? h.needsYou.map((n) => row(n, n.kind)).join("") : `<div class="empty">Nothing needs you.</div>`;
  const working = h.working.length ? h.working.map((w) => row(w, w.status)).join("") : `<div class="empty">Nothing running.</div>`;
  const degraded = Object.keys(h.degraded || {}).length ? `<div class="err">Unavailable: ${esc(Object.entries(h.degraded).map(([p, e]) => `${p} (${e.code})`).join(", "))}</div>` : "";
  $("#app").innerHTML = `${degraded}${newTaskCard()}<h2>NEEDS YOU</h2><div class="list needs">${needs}</div><h2>WORKING</h2><div class="list">${working}</div><h2>RECENT</h2><div class="list">${h.recent.map((r) => row(r, r.status)).join("")}</div>`;
  document.querySelectorAll(".row").forEach((el) => el.addEventListener("click", () => openSession(el.dataset.sid)));
}
// "New task": only providers whose capabilities declare a launcher (createVia) — today Cowork via Claude Desktop.
function newTaskCard() {
  const provs = Object.entries(caps).filter(([, c]) => c && c.canCreateSession && c.createVia);
  if (!provs.length) return "";
  const opts = provs.map(([p]) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  return `<div class="panel newtask"><b>New task</b> <select id="nt-prov">${opts}</select> <span class="caps">${esc(provs[0][1].createVia)}</span>
    <textarea id="nt-msg" rows="3" placeholder="What should it do?"></textarea>
    <input id="nt-project" placeholder="Project name (optional; blank = no folder)">
    <button id="nt-start">Start</button> <span id="nt-status" class="caps"></span><div class="err" id="err"></div></div>`;
}
function label(b, x) {
  if (b === "working") return x.forSeconds != null ? `Working ${fmtDur(x.forSeconds)}` : "Working";
  return { approval: "Approval required", approval_required: "Approval required", question: "Question", waiting_for_input: "Question", failure: "Failed", review: "Done", complete: "Done", interrupted: "Stopped", idle: "Idle", unknown: "—" }[b] || b;
}
const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`);

// ---------- session ----------
async function openSession(sessionId, keepLive) {
  location.hash = encodeURIComponent(sessionId);
  const [d, home] = await Promise.all([api("GET", `/api/sessions/${encodeURIComponent(sessionId)}`), api("GET", "/api/home")]);
  if (!keepLive) { liveText = ""; activity = []; }
  const c = d.capabilities || {};
  const pending = home.needsYou.filter((n) => n.sessionId === sessionId && (n.kind === "approval" || n.kind === "question"));
  view = { name: "session", sessionId, status: (d.live && d.live.status) || d.status, caps: c, provider: d.provider };
  if (home.needsYou.some((n) => n.sessionId === sessionId && n.kind === "review")) api("POST", `/api/sessions/${encodeURIComponent(sessionId)}/ack`).catch(() => {});
  const transcript = (d.messages || []).map((m) => `<div class="msg ${esc(m.role)}"><span class="who">${esc(m.role)}</span>${esc(m.text || (m.tool ? `${m.tool.name} ${JSON.stringify(m.tool.input || {}).slice(0, 160)}` : m.toolResult ? `→ ${m.toolResult.status || ""} ${m.toolResult.preview || ""}` : ""))}</div>`).join("");
  const reqHtml = pending.map((p) => `<div class="panel callout"><b>${p.kind === "approval" ? "Approval required" : "Question"}</b><div>${esc(p.text)}</div><div class="controls">${
    p.kind === "approval" ? `<button class="primary" data-act="approve" data-rid="${esc(p.requestId)}">Approve</button><button class="danger" data-act="deny" data-rid="${esc(p.requestId)}">Deny</button>`
      : (p.options || []).map((o) => `<button data-act="answer" data-rid="${esc(p.requestId)}" data-answer="${esc(o)}">${esc(o)}</button>`).join("")}</div></div>`).join("");
  $("#app").innerHTML = `
    <div class="sess-head"><span class="prov">${esc(home.needsYou.concat(home.working, home.recent).find((x) => x.sessionId === sessionId)?.providerLabel || d.provider)}</span><h1>${esc(d.title || sessionId)}</h1><span class="badge ${esc(view.status)}" id="st">${esc(label(view.status, {}))}</span></div>
    <div class="mono">${esc(sessionId)}${d.cwd ? " · " + esc(d.cwd) : ""}${d.writer ? " · writer: " + esc(d.writer.owner) : ""}</div>
    ${reqHtml}
    <div class="panel"><b>Latest output</b><div class="live" id="live"></div><div class="activity" id="activity"></div></div>
    <div class="panel"><b>Transcript</b> <span class="caps">(${(d.messages || []).length} of ${d.totalMessages ?? "?"}${c.historyComplete ? "" : ", rendered window only"})</span><div class="transcript">${transcript}</div></div>
    <div class="panel"><textarea id="msg" placeholder="Message…"></textarea>
      <div class="controls">
        <button class="primary" id="send">Send</button>
        <button id="steer" ${c.canSteer ? "" : "disabled title='not supported by this provider'"}>Steer</button>
        <button class="danger" id="stop" ${c.canInterrupt ? "" : "disabled"}>Stop</button>
        <button id="refresh">Refresh</button>
      </div><div class="caps">${esc(c.transport || "")} · stream: ${esc(c.streamGranularity || "")}${c.note ? " · " + esc(c.note) : ""}</div><div class="err" id="err"></div></div>`;
  paintLive();
  $("#counts").textContent = `${home.counts.needsYou} need you · ${home.counts.working} working`;
  const tr = document.querySelector(".transcript"); if (tr) tr.scrollTop = tr.scrollHeight;
}
// One delegated click handler: survives re-renders (per-element handlers could be lost if a click raced a re-render).
const act = async (fn) => { const e = $("#err"); if (e) e.textContent = ""; try { await fn(); } catch (err) { const el = $("#err"); if (el) el.textContent = `${err.code || "ERROR"}: ${err.message}`; else console.error(err); } };
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("button"); if (!b || b.disabled) return;
  if (b.id === "nt-start") return act(async () => {
    const message = $("#nt-msg").value.trim(); if (!message) return;
    const project = $("#nt-project").value.trim() || undefined;
    b.disabled = true; $("#nt-status").textContent = "starting in Claude Desktop…";
    try { const r = await api("POST", "/api/sessions", { provider: $("#nt-prov").value, firstMessage: message, project }); openSession(r.sessionId); }
    finally { b.disabled = false; if ($("#nt-status")) $("#nt-status").textContent = ""; }
  });
  if (view.name !== "session") return;
  const sid = encodeURIComponent(view.sessionId);
  const msg = () => ($("#msg") ? $("#msg").value.trim() : "");
  if (b.id === "send") return act(async () => { const m = msg(); if (!m) return; await api("POST", `/api/sessions/${sid}/send`, { message: m }); $("#msg").value = ""; liveText = ""; activity = []; paintLive(); });
  if (b.id === "steer") return act(async () => { const m = msg(); if (!m) return; await api("POST", `/api/sessions/${sid}/steer`, { message: m }); $("#msg").value = ""; });
  if (b.id === "stop") return act(() => api("POST", `/api/sessions/${sid}/interrupt`));
  if (b.id === "refresh") return openSession(view.sessionId);
  if (b.dataset.act) return act(async () => {
    await api("POST", `/api/requests/${encodeURIComponent(b.dataset.rid)}/${b.dataset.act}`, b.dataset.act === "answer" ? { answer: b.dataset.answer } : {});
    setTimeout(() => openSession(view.sessionId, true), 600);
  });
});
function paintLive() {
  const l = $("#live"); if (l) l.textContent = liveText || "—";
  const a = $("#activity"); if (a) a.textContent = activity.slice(-12).join("\n");
  const st = $("#st"); if (st && view.status) { st.textContent = label(view.status, {}); st.className = "badge " + view.status; }
}

$("#home-link").addEventListener("click", (e) => { e.preventDefault(); renderHome(); });
window.addEventListener("hashchange", () => { const sid = decodeURIComponent(location.hash.slice(1)); if (sid && (!view.sessionId || sid !== view.sessionId)) openSession(sid); });
api("GET", "/api/capabilities").then((c) => (caps = c)).catch(() => {});
connectEvents();
(location.hash.length > 1 ? openSession(decodeURIComponent(location.hash.slice(1))) : renderHome()).catch((e) => { $("#app").innerHTML = `<div class="err">${esc(e.code || "")} ${esc(e.message)}</div>`; });
