// AgentSessionAdapter implementation for Claude Code, on top of the official Claude Agent SDK.
// - discovery/read: SDK session store (listSessions/getSessionInfo/getSessionMessages): no process needed
// - live control: one SessionRuntime (SDK query, streaming input) per session, created lazily on first send
// - approvals/questions: PermissionBroker (canUseTool) → ApprovalRequest objects decided by id
// - single writer: SessionLock (file lock shared across adapter processes) held while a runtime is live
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { PermissionBroker } from "./permissionBroker.mjs";
import { SessionLock } from "@command-center/core/sessionLock.mjs";
import { RUN_DIR } from "@command-center/core/paths.mjs";
import { SessionRuntime } from "./sessionRuntime.mjs";
import { toSummary, toMessageViews, matchesQuery } from "./sessionView.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const err = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

export class ClaudeCodeAdapter extends EventEmitter {
  provider = "claude-code";

  /**
   * @param {object} [o]
   * @param {string} [o.owner]           lock owner label (e.g. "ccd:<pid>")
   * @param {string} [o.lockDir]
   * @param {string} [o.model]           default model for live runtimes (undefined → CLI default)
   * @param {string[]} [o.settingSources] SDK settingSources for live runtimes (undefined → SDK default)
   * @param {object} [o.sdkImpl]         injectable SDK (tests)
   */
  constructor(o = {}) {
    super();
    this.setMaxListeners(100);
    this.sdk = o.sdkImpl || sdk;
    this.model = o.model;
    this.settingSources = o.settingSources;
    this.owner = o.owner || `adapter:${process.pid}`;
    this.lock = new SessionLock(o.lockDir || path.join(RUN_DIR, "locks-claude-code"), this.owner);
    this.runtimes = new Map(); // sessionId -> SessionRuntime
    this.seqs = new Map();     // sessionId -> last emitted seq
    this.log = o.log || (() => {});
    this.broker = new PermissionBroker({
      onOpen: (req) => this.runtimes.get(req.sessionId)?.onRequestOpened(req),
      onClose: (req, decision) => this.runtimes.get(req.sessionId)?.onRequestClosed(req, decision),
    });
  }

  // ---------- discovery / read (no Claude process) ----------
  async listSessions(q, { limit, dir } = {}) {
    const infos = await this.sdk.listSessions({ dir, limit });
    return infos.map((i) => toSummary(i, this.#liveInfo(i.sessionId))).filter((s) => matchesQuery(s, q));
  }

  async getSession(sessionId, { limit = 20 } = {}) {
    this.#checkId(sessionId);
    const info = await this.sdk.getSessionInfo(sessionId);
    if (!info) throw err("NOT_FOUND", `no Claude Code session ${sessionId}`);
    const all = await this.sdk.getSessionMessages(sessionId, {});
    const views = toMessageViews(all.slice(-limit));
    return { ...toSummary(info, this.#liveInfo(sessionId)), messages: views, totalMessages: all.length, pendingApprovals: this.broker.list(sessionId) };
  }
  refreshSession(sessionId, o) { return this.getSession(sessionId, o); }

  getStatus(sessionId) {
    const rt = this.runtimes.get(sessionId);
    return { sessionId, live: !!rt && !rt.closed, status: rt ? rt.status.status : "idle", pendingApprovals: this.broker.list(sessionId), lock: this.lock.read(sessionId) };
  }

  // ---------- live control ----------
  async createSession({ cwd, title, model, firstMessage } = {}) {
    if (!cwd || !fs.existsSync(cwd)) throw err("BAD_CWD", `cwd does not exist: ${cwd}`);
    const sessionId = randomUUID(); // pre-assigned via Options.sessionId: stable identity before any output
    this.#start(sessionId, { isNew: true, cwd, title, model });
    if (firstMessage) this.runtimes.get(sessionId).send(firstMessage);
    return { sessionId, cwd, title, live: true };
  }

  /** Streams events from this send until the turn it started (or was merged into) completes. */
  async *sendMessage(sessionId, message) {
    const rt = await this.#ensureRuntime(sessionId);
    const queue = []; let wake = null; let myTurn = null; let finished = false;
    const onEvent = (e) => { if (e.sessionId === sessionId) { queue.push(e); if (wake) wake(); } };
    this.on("event", onEvent);
    try {
      myTurn = rt.send(message);
      yield { id: `sent:${myTurn}`, type: "sent", sessionId, turnId: myTurn, at: new Date().toISOString() };
      while (!finished) {
        if (!queue.length) await new Promise((r) => (wake = r));
        wake = null;
        while (queue.length) {
          const e = queue.shift();
          yield e;
          if (e.type === "turn_complete" && e.turnId === myTurn) finished = true;
        }
      }
    } finally {
      this.off("event", onEvent);
    }
  }

  /** Fire-and-forget variant for daemons: returns the client turn id immediately. */
  async send(sessionId, message) { return (await this.#ensureRuntime(sessionId)).send(message); }

  async interrupt(sessionId) {
    const rt = this.runtimes.get(sessionId);
    if (!rt || rt.closed) throw err("NOT_LIVE", `session ${sessionId} has no live runtime in this adapter`);
    return rt.interrupt();
  }

  listApprovals(sessionId) { return this.broker.list(sessionId); }
  async respondToApproval(requestId, decision, opts) {
    const req = this.broker.get(requestId);
    if (!req) throw err("NO_SUCH_REQUEST", `no pending request ${requestId}`);
    this.#assertLockHeld(req.sessionId);
    return this.broker.decide(requestId, decision, opts);
  }

  /** Stop the live process for a session (transcript stays on disk) and release the lock. */
  async closeSession(sessionId) {
    const rt = this.runtimes.get(sessionId);
    if (rt) { rt.close(); await Promise.race([rt.done, new Promise((r) => setTimeout(r, 5000))]); }
    this.runtimes.delete(sessionId);
    this.lock.release(sessionId);
  }
  async shutdown() { for (const id of [...this.runtimes.keys()]) await this.closeSession(id); }

  // ---------- internals ----------
  #checkId(id) { if (!UUID.test(id || "")) throw err("BAD_SESSION_ID", `not a Claude Code session id: ${id}`); }
  #liveInfo(id) { const rt = this.runtimes.get(id); return rt && !rt.closed ? { status: rt.status.status } : null; }
  #assertLockHeld(id) { const l = this.lock.read(id); if (!l || l.pid !== process.pid) throw err("LOCK_NOT_HELD", `this adapter does not hold the writer lock for ${id}`); }

  async #ensureRuntime(sessionId) {
    this.#checkId(sessionId);
    const rt = this.runtimes.get(sessionId);
    if (rt && !rt.closed) return rt;
    const info = await this.sdk.getSessionInfo(sessionId);
    if (!info) throw err("NOT_FOUND", `no Claude Code session ${sessionId}; refusing to create a replacement`);
    return this.#start(sessionId, { isNew: false, cwd: info.cwd });
  }

  #start(sessionId, { isNew, cwd, title, model }) {
    this.lock.acquire(sessionId); // throws SESSION_LOCKED if another live writer exists
    const sdkOptions = { cwd, model: model || this.model, ...(this.settingSources ? { settingSources: this.settingSources } : {}), ...(title ? { title } : {}) };
    const rt = new SessionRuntime({
      sessionId, isNew, broker: this.broker, sdkOptions, log: this.log,
      queryImpl: this.sdk.query,
      // seq is per session and monotonic across runtime respawns within this adapter process.
      emit: (e) => { const n = (this.seqs.get(sessionId) || 0) + 1; this.seqs.set(sessionId, n); this.emit("event", { ...e, seq: n }); },
    });
    this.runtimes.set(sessionId, rt);
    rt.done.then(() => { if (this.runtimes.get(sessionId) === rt) { this.runtimes.delete(sessionId); this.lock.release(sessionId); } });
    return rt;
  }
}
