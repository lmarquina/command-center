// AgentSessionAdapter for Codex, on the official Codex App Server (JSON-RPC over stdio).
// One app-server process per adapter instance; it becomes the *writer* for every thread it resumes/starts.
// Codex itself enforces one writer per thread across processes ("thread … already has an active writer"),
// e.g. Codex Desktop keeps the lock for any thread it has opened until it quits. Reads always work.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { AppServerClient } from "./appServerClient.mjs";
import { SessionLock } from "@command-center/core/sessionLock.mjs";
import { Deduper } from "@command-center/core/dedupe.mjs";
import { RUN_DIR } from "@command-center/core/paths.mjs";

const err = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

/** Codex ThreadStatus (+ last turn outcome) → normalized status. */
export function mapStatus(threadStatus, lastTurnStatus) {
  switch (threadStatus && threadStatus.type) {
    case "active": {
      const f = threadStatus.activeFlags || [];
      if (f.includes("waitingOnApproval")) return "approval_required";
      if (f.includes("waitingOnUserInput")) return "waiting_for_input";
      return "working";
    }
    case "systemError": return "failed";
    case "idle": return lastTurnStatus === "interrupted" ? "interrupted" : lastTurnStatus === "failed" ? "failed" : lastTurnStatus === "completed" ? "complete" : "idle";
    case "notLoaded": return "idle";
    default: return "unknown";
  }
}

/** Codex ThreadItem[] (from thread/read turns) → provider-neutral message views. */
export function itemsToViews(turns) {
  const out = [];
  for (const t of turns || []) for (const it of t.items || []) {
    if (it.type === "userMessage") out.push({ id: it.id, turnId: t.id, role: "user", text: (it.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") });
    else if (it.type === "agentMessage") out.push({ id: it.id, turnId: t.id, role: "assistant", text: it.text });
    else if (it.type === "commandExecution") out.push({ id: it.id, turnId: t.id, role: "tool", tool: { name: "commandExecution", input: { command: it.command, cwd: it.cwd } }, toolResult: { status: it.status, exitCode: it.exitCode, preview: (it.aggregatedOutput || "").slice(0, 200) } });
    else if (it.type === "fileChange") out.push({ id: it.id, turnId: t.id, role: "tool", tool: { name: "fileChange", input: { changes: (it.changes || []).map((c) => c.path) } }, toolResult: { status: it.status } });
    else if (it.type === "mcpToolCall") out.push({ id: it.id, turnId: t.id, role: "tool", tool: { name: `${it.server}.${it.tool}`, input: it.arguments }, toolResult: { status: it.status } });
  }
  return out;
}

export class CodexAdapter extends EventEmitter {
  provider = "codex";

  /** @param {{model?:string, effort?:string, approvalPolicy?:string, sandbox?:string, enableQuestions?:boolean, lockDir?:string, owner?:string, log?:Function, client?:object}} o */
  constructor(o = {}) {
    super(); this.setMaxListeners(100);
    this.o = { approvalPolicy: "on-request", sandbox: "workspace-write", enableQuestions: true, ...o };
    this.log = o.log || (() => {});
    this.lock = new SessionLock(o.lockDir || path.join(RUN_DIR, "locks-codex"), o.owner || `codex-adapter:${process.pid}`);
    this.loaded = new Map();     // threadId -> { activeTurnId, lastTurnStatus, status }
    this.approvals = new Map();  // approvalId -> { request, rpcId, method }
    this.seqs = new Map(); this.dedupe = new Deduper(); this.offsets = new Map();
    this.runtimeId = randomUUID().slice(0, 8);
    this.client = o.client || null;
  }

  async start() {
    // Structured questions in default mode are behind an under-development feature flag (Codex 0.160.1).
    const args = this.o.enableQuestions ? ["--enable", "default_mode_request_user_input"] : [];
    this.client = (!this.client || this.client.closed) ? (this.o.clientFactory ? this.o.clientFactory() : new AppServerClient({ args, log: this.log })) : this.client;
    this.client.on("notification", (m) => this.#onNotification(m));
    this.client.on("serverRequest", (m) => this.#onServerRequest(m));
    this.client.on("exit", (e) => this.#onExit(e));
    const init = await this.client.start();
    return { codexVersion: this.client.version, userAgent: init.userAgent };
  }

  // ---------- discovery / read ----------
  async listSessions(query, { limit = 100, archived = false } = {}) {
    const out = []; let cursor = null;
    do {
      const r = await this.client.request("thread/list", { limit: Math.min(limit, 100), cursor, archived, searchTerm: query || null });
      for (const t of r.data) out.push(this.#summary(t));
      cursor = r.nextCursor;
    } while (cursor && out.length < limit);
    return out;
  }
  async getSession(threadId, { limit = 20 } = {}) {
    const r = await this.client.request("thread/read", { threadId, includeTurns: true });
    const t = r.thread; const views = itemsToViews(t.turns);
    return { ...this.#summary(t), messages: views.slice(-limit), totalMessages: views.length, turns: (t.turns || []).length, pendingApprovals: this.listApprovals(threadId) };
  }
  refreshSession(id, o) { return this.getSession(id, o); }
  getStatus(threadId) { const l = this.loaded.get(threadId); return { sessionId: threadId, live: !!l, status: l ? l.status : "idle", activeTurnId: l && l.activeTurnId, pendingApprovals: this.listApprovals(threadId), lock: this.lock.read(threadId) }; }

  // ---------- live control ----------
  async createSession({ cwd, model, title } = {}) {
    const r = await this.client.request("thread/start", { cwd, model: model || this.o.model, approvalPolicy: this.o.approvalPolicy, sandbox: this.o.sandbox });
    const id = r.thread.id;
    this.lock.acquire(id);
    this.loaded.set(id, { activeTurnId: null, lastTurnStatus: null, status: "idle" });
    if (title) await this.client.request("thread/name/set", { threadId: id, name: title }).catch(() => {});
    return { ...this.#summary(r.thread), live: true };
  }

  async #ensureLoaded(threadId) {
    if (this.loaded.has(threadId)) return;
    this.lock.acquire(threadId); // command-center level single writer (also across adapter processes)
    try {
      await this.client.request("thread/resume", { threadId, model: this.o.model, approvalPolicy: this.o.approvalPolicy, sandbox: this.o.sandbox, excludeTurns: true });
    } catch (e) {
      this.lock.release(threadId);
      if (/active writer/.test(e.message)) throw err("WRITER_BUSY", `thread ${threadId} is held by another Codex process (e.g. Codex Desktop has it open); read-only until it releases`, { cause: e.message });
      throw e;
    }
    this.loaded.set(threadId, { activeTurnId: null, lastTurnStatus: null, status: "idle" });
  }

  /** Streams events from this send until its turn completes. If a turn is running, the message steers it. */
  async *sendMessage(threadId, message) {
    await this.#ensureLoaded(threadId);
    const st = this.loaded.get(threadId);
    const q = []; let wake = null; let myTurn = null; let steered = false;
    const onEv = (e) => { if (e.sessionId === threadId) { q.push(e); wake && wake(); } };
    this.on("event", onEv);
    try {
      const clientUserMessageId = randomUUID();
      const input = [{ type: "text", text: message, text_elements: [] }];
      if (st.activeTurnId) {
        const r = await this.client.request("turn/steer", { threadId, input, clientUserMessageId, expectedTurnId: st.activeTurnId });
        myTurn = r.turnId; steered = true;
        yield this.#mk(threadId, { id: `steer:${clientUserMessageId}`, type: "steer_accepted", turnId: myTurn });
      } else {
        const r = await this.client.request("turn/start", { threadId, input, clientUserMessageId, effort: this.o.effort });
        myTurn = r.turn.id; st.activeTurnId = myTurn;
      }
      yield this.#mk(threadId, { id: `sent:${clientUserMessageId}`, type: "sent", turnId: myTurn, steered });
      for (;;) {
        if (!q.length) await new Promise((r) => (wake = r));
        wake = null;
        while (q.length) { const e = q.shift(); yield e; if (e.type === "turn_complete" && e.turnId === myTurn) return; }
      }
    } finally { this.off("event", onEv); }
  }

  async steer(threadId, message) { const st = this.loaded.get(threadId); if (!st || !st.activeTurnId) throw err("NO_ACTIVE_TURN", "no active turn to steer"); return this.client.request("turn/steer", { threadId, input: [{ type: "text", text: message, text_elements: [] }], expectedTurnId: st.activeTurnId }); }

  async interrupt(threadId) {
    const st = this.loaded.get(threadId);
    if (!st || !st.activeTurnId) return { interrupted: false, reason: "no active turn" };
    await this.client.request("turn/interrupt", { threadId, turnId: st.activeTurnId });
    return { interrupted: true, turnId: st.activeTurnId };
  }

  listApprovals(threadId) { return [...this.approvals.values()].map((a) => a.request).filter((r) => !threadId || r.sessionId === threadId); }

  /** decision: approve|deny. For questions, opts.answers maps question id (or "_" for the only question) → answer label/text. */
  async respondToApproval(requestId, decision, opts = {}) {
    const a = this.approvals.get(requestId);
    if (!a) throw err("NO_SUCH_REQUEST", `no pending request ${requestId}`);
    let result;
    if (a.request.kind === "question") {
      if (decision === "deny") result = { answers: {} };
      else {
        const answers = {};
        for (const q of a.request.question) {
          const given = (opts.answers || {})[q.id] ?? (opts.answers || {})[q.text] ?? (a.request.question.length === 1 ? Object.values(opts.answers || {})[0] : undefined);
          if (given === undefined) throw err("MISSING_ANSWER", `no answer for question ${q.id}`);
          const exact = q.options.find((o) => o.toLowerCase() === String(given).toLowerCase());
          answers[q.id] = { answers: [exact || String(given)] };
        }
        result = { answers };
      }
    } else result = { decision: decision === "approve" ? "accept" : "decline" };
    this.client.reply(a.rpcId, result);
    return a.request; // removal + approval_resolved happen on serverRequest/resolved (authoritative)
  }

  async closeSession(threadId) {
    if (this.loaded.has(threadId)) await this.client.request("thread/unsubscribe", { threadId }).catch(() => {});
    this.loaded.delete(threadId); this.lock.release(threadId);
  }
  async shutdown() { this.stopping = true; for (const id of [...this.loaded.keys()]) await this.closeSession(id); this.client.stop(); }

  // ---------- events ----------
  #summary(t) {
    const l = this.loaded.get(t.id);
    return { provider: "codex", sessionId: t.id, title: t.name || t.preview || "(untitled)", cwd: t.cwd, gitBranch: t.gitInfo && t.gitInfo.branch, model: t.model, source: t.source, createdAt: t.createdAt && new Date(t.createdAt * 1000).toISOString(), updatedAt: t.updatedAt && new Date(t.updatedAt * 1000).toISOString(), status: l ? l.status : mapStatus(t.status), live: !!l, nativeStatus: t.status };
  }
  #mk(threadId, payload) {
    const n = (this.seqs.get(threadId) || 0) + 1; this.seqs.set(threadId, n);
    return { ...payload, id: payload.id || `${threadId}:${this.runtimeId}:${n}`, sessionId: threadId, seq: n, at: new Date().toISOString() };
  }
  #emit(threadId, payload) { if (payload.id && !this.dedupe.firstTime(payload.id)) return; this.emit("event", this.#mk(threadId, payload)); }
  #setStatus(threadId, status, reason) { const st = this.loaded.get(threadId); if (!st || st.status === status) return; st.status = status; this.#emit(threadId, { type: "status", value: status, reason }); }

  #onNotification({ method, params: p }) {
    const tid = p && p.threadId;
    switch (method) {
      case "thread/status/changed": {
        const st = this.loaded.get(tid);
        // Observed order: status→idle arrives just BEFORE turn/completed; let the turn outcome decide.
        if (st && !(p.status.type === "idle" && st.activeTurnId)) this.#setStatus(tid, mapStatus(p.status, p.status.type === "idle" ? st.lastTurnStatus : null), "native");
        break;
      }
      case "turn/started": { const st = this.loaded.get(tid); if (st) st.activeTurnId = p.turn.id; this.#emit(tid, { id: `ts:${p.turn.id}`, type: "turn_started", turnId: p.turn.id }); break; }
      case "item/agentMessage/delta": { const off = this.offsets.get(p.itemId) || 0; this.offsets.set(p.itemId, off + p.delta.length); this.#emit(tid, { id: `d:${p.itemId}:${off}`, type: "assistant_delta", messageId: p.itemId, offset: off, text: p.delta }); break; }
      case "item/started": { const it = p.item; if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(it.type)) this.#emit(tid, { id: `t:${it.id}`, type: "tool_call", tool: it.type === "mcpToolCall" ? `${it.server}.${it.tool}` : it.type, toolUseId: it.id, details: { command: it.command, cwd: it.cwd, changes: it.changes && it.changes.map((c) => c.path), arguments: it.arguments } }); break; }
      case "item/completed": {
        const it = p.item;
        if (it.type === "agentMessage") this.#emit(tid, { id: `m:${it.id}`, type: "assistant_message", messageId: it.id, text: it.text });
        else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(it.type)) this.#emit(tid, { id: `r:${it.id}`, type: "tool_result", toolUseId: it.id, isError: ["failed", "declined"].includes(it.status), status: it.status, preview: (it.aggregatedOutput || "").slice(0, 300) });
        break;
      }
      case "serverRequest/resolved": {
        for (const [aid, a] of this.approvals) if (a.request.sessionId === tid && a.rpcId === p.requestId) { this.approvals.delete(aid); this.#emit(tid, { id: `ar:${aid}`, type: "approval_resolved", requestId: aid }); }
        break;
      }
      case "turn/completed": {
        const st = this.loaded.get(tid); const t = p.turn;
        if (st) { st.lastTurnStatus = t.status; if (st.activeTurnId === t.id) st.activeTurnId = null; }
        const outcome = t.status === "completed" ? "complete" : t.status; // completed|interrupted|failed
        const text = (t.items || []).filter((x) => x.type === "agentMessage").map((x) => x.text).pop();
        if (st) this.#setStatus(tid, outcome, "turn completed");
        this.#emit(tid, { id: `c:${t.id}`, type: "turn_complete", turnId: t.id, outcome, result: text, error: t.error, durationMs: t.durationMs });
        break;
      }
      case "error": this.#emit(tid, { type: "error", message: JSON.stringify(p).slice(0, 300) }); break;
    }
  }

  #onServerRequest(m) {
    const p = m.params || {};
    // Globally unique, stable approval id: the JSON-RPC id is only unique per connection.
    const approvalId = p.approvalId || `${p.threadId}:${p.itemId}`;
    let request;
    if (m.method === "item/commandExecution/requestApproval" || m.method === "execCommandApproval")
      request = { requestId: approvalId, sessionId: p.threadId, provider: "codex", kind: "tool", tool: "commandExecution", toolUseId: p.itemId, description: `Run: ${p.command || "(command)"}`, details: { command: p.command, cwd: p.cwd, reason: p.reason, commandActions: p.commandActions, turnId: p.turnId }, createdAt: new Date().toISOString() };
    else if (m.method === "item/fileChange/requestApproval" || m.method === "applyPatchApproval")
      request = { requestId: approvalId, sessionId: p.threadId, provider: "codex", kind: "tool", tool: "fileChange", toolUseId: p.itemId, description: `Change files${p.grantRoot ? ` under ${p.grantRoot}` : ""}${p.reason ? `: ${p.reason}` : ""}`, details: { reason: p.reason, grantRoot: p.grantRoot, turnId: p.turnId }, createdAt: new Date().toISOString() };
    else if (m.method === "item/permissions/requestApproval")
      request = { requestId: approvalId, sessionId: p.threadId, provider: "codex", kind: "tool", tool: "permissions", toolUseId: p.itemId, description: "Grant additional permissions", details: p, createdAt: new Date().toISOString() };
    else if (m.method === "item/tool/requestUserInput")
      request = { requestId: approvalId, sessionId: p.threadId, provider: "codex", kind: "question", tool: "requestUserInput", toolUseId: p.itemId, description: p.questions.map((q) => q.question).join(" / "), question: p.questions.map((q) => ({ id: q.id, text: q.question, header: q.header, allowOther: q.isOther, secret: q.isSecret, options: (q.options || []).map((o) => o.label) })), details: { isBlocking: p.isBlocking, autoResolutionMs: p.autoResolutionMs }, createdAt: new Date().toISOString() };
    else {
      // Unknown server request kind: fail closed (do not auto-answer), surface it.
      this.#emit(p.threadId, { type: "error", message: `unsupported server request ${m.method}; left unanswered` });
      return;
    }
    this.approvals.set(approvalId, { request, rpcId: m.id, method: m.method });
    this.#emit(p.threadId, { id: `a:${approvalId}`, type: request.kind === "question" ? "question" : "approval_required", request });
  }

  #onExit(e) {
    for (const [tid, st] of this.loaded) {
      if (st.activeTurnId) this.#emit(tid, { id: `c:${st.activeTurnId}:exit`, type: "turn_complete", turnId: st.activeTurnId, outcome: "failed", result: "codex app-server exited" });
      st.activeTurnId = null; this.#setStatus(tid, "failed", "app-server exited");
      this.lock.release(tid);
    }
    this.loaded.clear(); this.approvals.clear();
    this.emit("exit", e);
    // Self-heal: start a fresh app-server; threads are re-resumed lazily on the next send.
    if (!this.stopping) setTimeout(() => this.start().then((r) => { this.restarts = (this.restarts || 0) + 1; this.emit("restarted", r); }, (err2) => this.emit("restartFailed", err2)), 300);
  }
}
