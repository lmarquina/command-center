// Provider-agnostic view model for the home screen (and later the G2 HOME/SESSION LIST screens).
// Pure: sessions (SessionCore.listSessions), attention (NeedsAttention), live (sessionId → last status/at from events).
const ACTIVE = new Set(["working", "approval_required", "waiting_for_input"]);
const PROVIDER_LABEL = { "claude-code": "Claude Code", codex: "Codex", cowork: "Cowork", chatgpt: "ChatGPT" };

export function providerLabel(p) { return PROVIDER_LABEL[p] || p; }

export function buildHome({ sessions = [], attention = [], live = {}, recentLimit = 25, perProviderMin = 5, now = Date.now() }) {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const title = (sid) => (byId.get(sid) && byId.get(sid).title) || sid;
  const needsYou = attention.map((a) => ({
    kind: a.kind, sessionId: a.sessionId, provider: a.provider, providerLabel: providerLabel(a.provider),
    title: title(a.sessionId), requestId: a.requestId, text: a.text, options: a.options || [], at: a.at,
    headline: a.kind === "approval" ? "Approval required" : a.kind === "question" ? "Question" : a.kind === "failure" ? "Failed" : "Done: review",
  }));
  const statusOf = (s) => (live[s.sessionId] && live[s.sessionId].status) || s.status || "unknown";
  // Sessions the harness itself marks as waiting on you (e.g. claude.ai "Awaiting input") but with no structured request.
  for (const s of sessions) if (statusOf(s) === "waiting_for_input" && !needsYou.some((n) => n.sessionId === s.sessionId))
    needsYou.push({ kind: "input", sessionId: s.sessionId, provider: s.provider, providerLabel: providerLabel(s.provider), title: s.title || s.sessionId, text: "Waiting for your input", options: [], headline: "Awaiting your input" });
  const needIds = new Set(needsYou.filter((n) => n.kind === "approval" || n.kind === "question" || n.kind === "input").map((n) => n.sessionId));
  const working = sessions.filter((s) => ACTIVE.has(statusOf(s)) && !needIds.has(s.sessionId)).map((s) => ({
    ...pick(s), status: statusOf(s), since: live[s.sessionId] && live[s.sessionId].since, forSeconds: live[s.sessionId] && live[s.sessionId].since ? Math.round((now - Date.parse(live[s.sessionId].since)) / 1000) : null,
  }));
  const workingIds = new Set(working.map((w) => w.sessionId));
  const rest = sessions.filter((s) => !workingIds.has(s.sessionId) && !needIds.has(s.sessionId))
    .sort((a, b) => String((live[b.sessionId] || {}).at || b.updatedAt || "").localeCompare(String((live[a.sessionId] || {}).at || a.updatedAt || "")));
  // Newest overall, plus a few per provider so providers without timestamps (UI bridges) are never hidden.
  const chosen = new Set(rest.slice(0, recentLimit).map((s) => s.sessionId));
  const perProvider = {};
  for (const s of rest) { perProvider[s.provider] = (perProvider[s.provider] || 0) + 1; if (perProvider[s.provider] <= perProviderMin) chosen.add(s.sessionId); }
  const recent = rest.filter((s) => chosen.has(s.sessionId)).map((s) => ({ ...pick(s), status: statusOf(s) }));
  return { counts: { needsYou: needsYou.length, working: working.length }, needsYou, working, recent };
}
function pick(s) { return { sessionId: s.sessionId, provider: s.provider, providerLabel: providerLabel(s.provider), title: s.title, cwd: s.cwd, updatedAt: s.updatedAt }; }

/** Fold one unified event into the live-status map (what the UI and G2 show without re-listing). */
export function foldLive(live, ev) {
  if (ev.type === "status.changed") {
    const prev = live[ev.sessionId] || {};
    const since = ACTIVE.has(ev.status) && ACTIVE.has(prev.status) ? prev.since : ev.at;
    live[ev.sessionId] = { status: ev.status, since, at: ev.at };
  } else if (ev.type === "agent.started") live[ev.sessionId] = { status: "working", since: ev.at, at: ev.at };
  else if (/^agent\.(completed|interrupted|failed)$/.test(ev.type)) live[ev.sessionId] = { status: { "agent.completed": "complete", "agent.interrupted": "interrupted", "agent.failed": "failed" }[ev.type], since: ev.at, at: ev.at };
  return live;
}
