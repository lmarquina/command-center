// One live Claude Code process (SDK query in streaming-input mode) bound to exactly one session id.
// Resume is always `resume: <id>` WITHOUT forkSession, so the transcript and id are preserved; the runtime
// verifies the id reported by system/init and fails closed if the CLI ever reports a different one.
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { StatusMachine } from "./statusMachine.mjs";
import { Deduper } from "@command-center/core/dedupe.mjs";
import { EventNormalizer } from "./eventNormalizer.mjs";

export class SessionRuntime {
  /**
   * @param {object} p
   * @param {string} p.sessionId     canonical id (existing session to resume, or pre-assigned id for a new one)
   * @param {boolean} p.isNew        true → create with options.sessionId; false → resume
   * @param {object} p.broker        PermissionBroker
   * @param {object} p.sdkOptions    extra SDK options (cwd, model, settingSources, title)
   * @param {(e:object)=>void} p.emit  event sink (adapter fan-out)
   * @param {Function} [p.queryImpl] injectable for tests
   */
  constructor({ sessionId, isNew, broker, sdkOptions, emit, queryImpl, log }) {
    Object.assign(this, { sessionId, isNew, broker, emit, log: log || (() => {}) });
    this.status = new StatusMachine("idle");
    this.normalizer = new EventNormalizer();
    this.deduper = new Deduper();
    this.seq = 0;
    this.runtimeId = randomUUID().slice(0, 8);
    this.inbox = []; this.wake = null; this.closed = false;
    this.pendingClient = [];       // [{turnId, sentAt}] awaiting their replay echo
    this.currentTurn = null;       // {turnId, origin}
    this.initSessionId = null;
    this.startedAt = Date.now();
    const options = {
      ...sdkOptions,
      permissionMode: "default",                // approvals must reach canUseTool (SDK may default to 'auto')
      includePartialMessages: true,
      canUseTool: broker.callbackFor(sessionId),
      stderr: (d) => this.log("cli-stderr", d.slice(0, 300)),
      // Echo client user messages back (isReplay + our uuid): exact correlation of sends to turns.
      extraArgs: { ...(sdkOptions.extraArgs || {}), "replay-user-messages": null },
      ...(isNew ? { sessionId } : { resume: sessionId }),
    };
    this.q = (queryImpl || query)({ prompt: this.#input(), options });
    this.done = this.#pump();
  }

  async *#input() {
    while (!this.closed) {
      const m = this.inbox.shift() || (await new Promise((r) => (this.wake = r)));
      this.wake = null;
      if (m) yield m;
    }
  }

  #emit(payload) {
    if (payload.id && !this.deduper.firstTime(payload.id)) return; // duplicate suppression
    // Non-native events get runtime-scoped ids so a respawned runtime can never collide with an earlier one.
    this.seq++;
    this.emit({ ...payload, id: payload.id || `${this.sessionId}:${this.runtimeId}:${this.seq}`, sessionId: this.sessionId, runtimeId: this.runtimeId, seq: this.seq, at: new Date().toISOString() });
  }
  #facts(fact, reason) {
    for (const value of this.status.apply(fact)) this.#emit({ type: "status", value, reason });
  }

  /** Queue a user message. Returns the client turn id. Works while idle or while a turn is running (steering). */
  send(text) {
    if (this.closed) throw Object.assign(new Error("runtime closed"), { code: "RUNTIME_CLOSED" });
    const turnId = randomUUID();
    this.pendingClient.push({ turnId, sentAt: Date.now() });
    const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId, uuid: turnId };
    if (this.wake) this.wake(msg); else this.inbox.push(msg);
    if (!this.currentTurn) this.#facts({ type: "turn_start" }, "client message sent"); // immediate feedback; init confirms
    return turnId;
  }

  async interrupt() {
    // Interrupt only affects a RUNNING turn. A message that is queued but whose turn has not started is not
    // cancelled by the CLI (observed live), so report that honestly instead of claiming success.
    if (!this.currentTurn) return { interrupted: false, reason: this.pendingClient.length ? "turn not started yet (message queued)" : "no active turn" };
    this.#facts({ type: "interrupt_sent" });
    const r = await this.q.interrupt();
    return { interrupted: true, response: r };
  }

  onRequestOpened(req) { this.#facts({ type: "request_opened", requestId: req.requestId, kind: req.kind }, req.kind); this.#emit({ id: `a:${req.requestId}`, type: req.kind === "question" ? "question" : "approval_required", request: req }); }
  onRequestClosed(req, decision) { this.#emit({ id: `ar:${req.requestId}`, type: "approval_resolved", requestId: req.requestId, decision }); this.#facts({ type: "request_closed", requestId: req.requestId }, decision); }

  async #pump() {
    try {
      for await (const m of this.q) this.#onMessage(m);
      this.#facts({ type: "process_exit", error: false }, "process ended");
    } catch (e) {
      this.#emit({ type: "error", message: e.message });
      this.#facts({ type: "process_exit", error: true }, e.message);
    } finally {
      this.closed = true;
      // The running turn (and anything merged into or queued behind it) can never complete now.
      const open = [];
      if (this.currentTurn) open.push(this.currentTurn.turnId || `u:${this.currentTurn.initUuid}`, ...this.currentTurn.merged);
      open.push(...this.pendingClient.splice(0).map((p) => p.turnId));
      this.currentTurn = null;
      for (const t of open) this.#emit({ id: `c:${t}:exit`, type: "turn_complete", turnId: t, outcome: "failed", result: "Claude Code process exited" });
    }
  }

  // Turn correlation (exact, via replay-user-messages):
  //   system/init                      → a turn begins; origin unknown yet
  //   user replay with our uuid        → (first in turn) this is our client turn
  //                                      (later in a running turn) our message was merged into it (steering)
  //   any turn content with no replay  → unsolicited turn (e.g. background-task notification)
  //   result                           → turn ends; merged client turns complete with it
  #onMessage(m) {
    if (m.type === "system" && m.subtype === "init") {
      if (m.session_id !== this.sessionId) {
        // Fail closed: never let a different id masquerade as the requested session.
        this.#emit({ type: "error", message: `CLI reported session ${m.session_id}, expected ${this.sessionId}; closing` });
        this.close();
        return;
      }
      this.currentTurn = { turnId: null, initUuid: m.uuid, merged: [] };
      this.#facts({ type: "turn_start" }, "init");
    }
    if (m.type === "user" && m.isReplay) {
      const i = this.pendingClient.findIndex((p) => p.turnId === m.uuid);
      if (i >= 0) {
        const [p] = this.pendingClient.splice(i, 1);
        if (this.currentTurn && !this.currentTurn.turnId) {
          this.currentTurn.turnId = p.turnId; this.currentTurn.origin = "client";
          this.#emit({ id: `ts:${p.turnId}`, type: "turn_started", turnId: p.turnId, origin: "client" });
        } else if (this.currentTurn) {
          this.currentTurn.merged.push(p.turnId);
          this.#emit({ id: `mg:${p.turnId}`, type: "steer_accepted", turnId: p.turnId, intoTurn: this.currentTurn.turnId });
        }
      }
      return; // replays carry no new content
    }
    if (this.currentTurn && !this.currentTurn.turnId && (m.type === "assistant" || m.type === "stream_event" || m.type === "result")) {
      this.currentTurn.turnId = `u:${this.currentTurn.initUuid}`; this.currentTurn.origin = "unsolicited";
      this.#emit({ id: `ts:${this.currentTurn.turnId}`, type: "turn_started", turnId: this.currentTurn.turnId, origin: "unsolicited" });
    }
    for (const e of this.normalizer.normalize(m)) this.#emit(e);
    if (m.type === "result") {
      const turn = this.currentTurn || { turnId: `u:${m.uuid}`, merged: [] };
      this.#facts({ type: "turn_end", subtype: m.subtype, terminal: m.terminal_reason }, m.subtype);
      const outcome = this.status.status === "complete" ? "complete" : this.status.status === "interrupted" ? "interrupted" : "failed";
      const result = typeof m.result === "string" ? m.result : undefined;
      this.#emit({ id: `c:${m.uuid}`, type: "turn_complete", turnId: turn.turnId, outcome, result, costUsd: m.total_cost_usd, durationMs: m.duration_ms, terminal: m.terminal_reason });
      for (const t of turn.merged) this.#emit({ id: `c:${m.uuid}:${t}`, type: "turn_complete", turnId: t, outcome, result, mergedInto: turn.turnId });
      this.currentTurn = null;
    }
  }

  close() {
    if (this.closed && !this.q) return;
    this.closed = true;
    if (this.wake) this.wake(null);
    try { this.q.close(); } catch {}
  }
}
