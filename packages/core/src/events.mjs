// Normalized event vocabulary (brief POC 2) and per-transport mappers. Pure functions → unit-tested.
//
//   session.created  session.updated  status.changed
//   agent.started  agent.output.delta  agent.output.complete
//   tool.started  tool.completed
//   question.requested  question.answered
//   approval.requested  approval.approved  approval.denied  approval.cancelled
//   steer.accepted  agent.interrupted  agent.completed  agent.failed  error
//
// Every event: { id, type, sessionId (canonical), provider, at, seq?, ...payload }. `id` is deterministic and
// derived from native ids where possible, so the event bus can de-duplicate replays.
import { sessionIdFor, requestIdFor } from "./ids.mjs";

export const EVENT_TYPES = [
  "sessions.changed",
  "session.created", "session.updated", "status.changed",
  "agent.started", "agent.output.delta", "agent.output.complete",
  "tool.started", "tool.completed",
  "question.requested", "question.answered",
  "approval.requested", "approval.approved", "approval.denied", "approval.cancelled",
  "steer.accepted", "agent.interrupted", "agent.completed", "agent.failed", "error",
];
export const STATUSES = ["idle", "working", "waiting_for_input", "approval_required", "complete", "interrupted", "failed", "unknown"];

function mkRequest(provider, sessionId, r) {
  return { requestId: requestIdFor(provider, r.requestId), sessionId, provider, kind: r.kind, tool: r.tool, description: r.description,
    question: r.question && r.question.map((q) => ({ id: q.id || q.text, text: q.text, header: q.header, options: q.options || [], allowOther: q.allowOther })),
    details: r.details, createdAt: r.createdAt || new Date().toISOString() };
}

/**
 * Claude Code + Codex adapters share one native event vocabulary (status, turn_started, assistant_delta, assistant_message,
 * tool_call, tool_result, approval_required, question, approval_resolved, steer_accepted, turn_complete, error).
 * @param {"claude-code"|"codex"} provider
 * @param {object} e native adapter event
 * @param {Map} [pending] requestId → kind (to map approval_resolved to approved/denied/answered)
 */
export function fromAdapterEvent(provider, e, pending = new Map()) {
  const sessionId = sessionIdFor(provider, e.sessionId);
  const base = { provider, sessionId, at: e.at || new Date().toISOString(), turnId: e.turnId };
  const id = `${provider}:${e.id}`;
  switch (e.type) {
    case "status": return [{ ...base, id, type: "status.changed", status: e.value, reason: e.reason }];
    case "turn_started": return [{ ...base, id, type: "agent.started", origin: e.origin }];
    case "assistant_delta": return [{ ...base, id, type: "agent.output.delta", messageId: e.messageId, offset: e.offset, text: e.text }];
    case "assistant_message": return [{ ...base, id, type: "agent.output.complete", messageId: e.messageId, text: e.text }];
    case "tool_call": return [{ ...base, id, type: "tool.started", tool: e.tool, toolUseId: e.toolUseId, details: e.details }];
    case "tool_result": return [{ ...base, id, type: "tool.completed", toolUseId: e.toolUseId, isError: !!e.isError, status: e.status, preview: e.preview }];
    case "approval_required": { const r = mkRequest(provider, sessionId, e.request); pending.set(r.requestId, { kind: "tool", decision: null }); return [{ ...base, id, type: "approval.requested", request: r }]; }
    case "question": { const r = mkRequest(provider, sessionId, e.request); pending.set(r.requestId, { kind: "question", decision: null }); return [{ ...base, id, type: "question.requested", request: r }]; }
    case "approval_resolved": {
      const rid = requestIdFor(provider, e.requestId); const p = pending.get(rid) || {}; pending.delete(rid);
      const d = e.decision || p.decision; // claude-code reports the decision; codex resolution carries none (use what we sent)
      const type = p.kind === "question" ? (d === "deny" || d === "cancelled" ? "approval.cancelled" : "question.answered")
        : d === "approve" ? "approval.approved" : d === "deny" ? "approval.denied" : d === "cancelled" ? "approval.cancelled" : "approval.approved";
      return [{ ...base, id, type, requestId: rid }];
    }
    case "steer_accepted": return [{ ...base, id, type: "steer.accepted", intoTurn: e.intoTurn || e.turnId }];
    case "turn_complete": {
      const t = e.outcome === "complete" ? "agent.completed" : e.outcome === "interrupted" ? "agent.interrupted" : "agent.failed";
      return [{ ...base, id, type: t, result: e.result, error: e.error, mergedInto: e.mergedInto }];
    }
    case "error": return [{ ...base, id, type: "error", message: e.message }];
    default: return []; // "sent" acks and anything unknown are not part of the unified stream
  }
}

/** Chrome bridge events (Cowork + ChatGPT): session.statusChanged, messageAdded, messageUpdated, approvalRequested, questionRequested, completed, interrupted, changed. */
export function fromBridgeEvent(e) {
  if (e.event === "session.listChanged" && Array.isArray(e.sessions)) {   // pushed session list (sidebar changed)
    const provider = e.provider === "chatgpt" ? "chatgpt" : "cowork";
    const sig = e.sessions.map((x) => `${x.sessionId}|${x.status || ""}|${x.title || ""}`).join(";");
    let h = 0; for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
    return [{ id: `${provider}:list:${h}:${e.at || ""}`, type: "sessions.changed", provider, sessionId: `${provider}:_list`, at: e.at || new Date().toISOString(), sessions: e.sessions }];
  }
  if (!e.sessionId) return [];
  const provider = e.provider === "chatgpt" || String(e.sessionId).startsWith("chatgpt:") ? "chatgpt" : "cowork";
  let sessionId; try { sessionId = sessionIdFor(provider, e.sessionId); } catch { return []; }
  const base = { provider, sessionId, at: e.at || new Date().toISOString() };
  const k = `${provider}:${e.sessionId}:${e.event}:${e.key || ""}:${e.status || ""}:${e.textLength || ""}:${e.at}`;
  switch (e.event) {
    case "session.statusChanged": {
      const out = [{ ...base, id: k, type: "status.changed", status: e.status, from: e.from }];
      if (e.status === "working" && e.from !== "working" && !["approval_required", "waiting_for_input"].includes(e.from)) out.push({ ...base, id: k + ":start", type: "agent.started" });
      if (e.status === "failed") out.push({ ...base, id: k + ":fail", type: "agent.failed" });
      return out;
    }
    case "session.messageAdded":
      // A bridge message can be first seen mid-stream; only session.messageFinal (emitted at turn end) is "complete".
      return e.role === "assistant" ? [{ ...base, id: `${provider}:${e.sessionId}:msg:${e.key}`, type: "agent.output.delta", messageId: e.key, text: e.text, tools: e.tools, snapshot: true }]
        : [{ ...base, id: `${provider}:${e.sessionId}:msg:${e.key}`, type: "session.updated", userMessage: e.text }];
    case "session.messageUpdated": return [{ ...base, id: k, type: "agent.output.delta", messageId: e.key, text: e.delta || e.tail || "", textLength: e.textLength }];
    case "session.approvalRequested": return [{ ...base, id: k, type: "approval.requested", request: { requestId: requestIdFor(provider, `${e.sessionId}#approval`), sessionId, provider, kind: "tool", description: (e.approval && (e.approval.detail || e.approval.text)) || "Approval required", details: e.approval, createdAt: base.at } }];
    case "session.questionRequested": return [{ ...base, id: k, type: "question.requested", request: { requestId: requestIdFor(provider, `${e.sessionId}#question`), sessionId, provider, kind: "question", description: e.question && e.question.text, question: [{ id: "_", text: e.question && e.question.text, options: (e.question && e.question.options) || [] }], createdAt: base.at } }];
    case "session.messageFinal": return [{ ...base, id: `${provider}:${e.sessionId}:final:${e.key}:${(e.text || "").length}`, type: "agent.output.complete", messageId: e.key, text: e.text, final: true }];
    case "session.completed": return [{ ...base, id: k, type: "agent.completed" }];
    case "session.interrupted": return [{ ...base, id: k, type: "agent.interrupted" }];
    case "session.changed": return [{ ...base, id: k, type: "session.updated", status: e.status }];
    default: return [];
  }
}
