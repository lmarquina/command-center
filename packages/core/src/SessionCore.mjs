// SessionCore: the unified session layer. The UI / G2 / CLI talk only to this.
import { EventEmitter } from "node:events";
import { parseSessionId, sessionIdFor, parseRequestId, PROVIDERS } from "./ids.mjs";
import { CAPABILITIES } from "./capabilities.mjs";
import { LockManager } from "./locks.mjs";
import { AttentionBoard } from "./attention.mjs";
import { Presentation } from "./presentation.mjs";

const TERMINAL = new Set(["agent.completed", "agent.interrupted", "agent.failed"]);
const err = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

export class SessionCore extends EventEmitter {
  /** @param {{providers: Record<string, object>, lockTtlMs?: number, presentation?: object}} o */
  constructor({ providers, lockTtlMs, presentation } = {}) {
    super(); this.setMaxListeners(200);
    this.providers = providers;            // name -> provider (subset of PROVIDERS)
    this.locks = new LockManager({ ttlMs: lockTtlMs });
    this.attention = new AttentionBoard();
    this.seen = new Set(); this.seqs = new Map(); this.health = {};
    this.present = presentation instanceof Presentation ? presentation : new Presentation(presentation);   // demo masking (off by default)
    this.known = new Map();   // sessionId -> last listed row (for masking items and events)
    for (const [name, p] of Object.entries(providers)) p.onEvent((ev) => this.#publish(ev));
  }

  async start() {
    for (const [name, p] of Object.entries(this.providers)) {
      try { await p.start(); this.health[name] = { ok: true }; } catch (e) { this.health[name] = { ok: false, error: e.message, code: e.code }; }
    }
    return this.health;
  }
  async stop() { for (const p of Object.values(this.providers)) { try { await p.stop(); } catch {} } }

  capabilities(provider) { return provider ? CAPABILITIES[provider] : Object.fromEntries(Object.keys(this.providers).map((p) => [p, CAPABILITIES[p]])); }

  #provider(name) { const p = this.providers[name]; if (!p) throw err("PROVIDER_UNAVAILABLE", `provider ${name} is not configured`); return p; }
  #route(sessionId) { const id = parseSessionId(sessionId); return { ...id, p: this.#provider(id.provider) }; }
  #publish(ev) {
    if (this.seen.has(ev.id)) return;                       // de-duplicate (multi-tab, replay, double paths)
    this.seen.add(ev.id); if (this.seen.size > 20000) this.seen.delete(this.seen.values().next().value);
    const n = (this.seqs.get(ev.sessionId) || 0) + 1; this.seqs.set(ev.sessionId, n);
    const out = { ...ev, seq: n };
    this.attention.apply(out);
    this.emit("event", this.present.event(out, this.known.get(ev.sessionId) || { sessionId: ev.sessionId }));
  }

  // ---------- reads (no lock) ----------
  async listSessions(query, { providers } = {}) {
    const names = (providers || Object.keys(this.providers));
    const results = await Promise.allSettled(names.map((n) => this.#provider(n).list(query)));
    const sessions = [], degraded = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") for (const s of r.value) sessions.push({ ...s, provider: names[i], sessionId: sessionIdFor(names[i], s.nativeId), capabilities: undefined });
      else degraded[names[i]] = { code: r.reason.code, message: r.reason.message };
    });
    sessions.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    for (const s of sessions) this.known.set(s.sessionId, s);
    return { sessions: sessions.map((s) => this.present.row(s)), degraded };
  }
  async getSession(sessionId, o) {
    const { p, native, provider } = this.#route(sessionId); const d = await p.get(native, o);
    const out = { ...d, sessionId, provider, capabilities: CAPABILITIES[provider], writer: this.locks.holder(sessionId) };
    if (this.present.shows(this.known.get(sessionId) || { sessionId, title: d.title, cwd: d.cwd })) return out;
    const row = this.present.row({ sessionId, title: d.title });
    return { ...out, title: row.title, masked: true, messages: (out.messages || []).map((m) => ({ role: m.role, text: this.present.event({ text: m.text || "x" }, null).text })) };
  }
  async getStatus(sessionId) { const { p, native } = this.#route(sessionId); return { sessionId, ...(await p.status(native)), writer: this.locks.holder(sessionId) }; }
  /** True if the attention list mentions a session whose details (folder, title) haven't been listed yet. */
  hasUnknownAttention() { return this.present.enabled && this.attention.list().some((a) => !this.known.has(a.sessionId)); }
  needsAttention() { return this.attention.list().map((a) => this.present.item(a, this.known.get(a.sessionId) || { sessionId: a.sessionId })); }
  /** Inner steps of a step group / one step's details (reads; only providers that support it, e.g. Cowork). */
  async stepList(sessionId, o) { const { p, native, provider } = this.#route(sessionId); if (!p.stepList) throw err("NOT_SUPPORTED", `${provider} has no step groups`); return p.stepList(native, o); }
  async stepOpen(sessionId, o) { const { p, native, provider } = this.#route(sessionId); if (!p.stepOpen) throw err("NOT_SUPPORTED", `${provider} has no step groups`); return p.stepOpen(native, o); }
  ack(sessionId) { this.attention.ack(sessionId); }

  // ---------- writes (single writer per session) ----------
  async createSession({ provider, client, ...opts }) {
    const p = this.#provider(provider);
    if (!CAPABILITIES[provider].canCreateSession) throw err("NOT_SUPPORTED", `${provider} cannot create sessions through the command center`);
    const s = await p.create(opts);
    const sessionId = sessionIdFor(provider, s.nativeId);
    this.present.created.add(sessionId);   // made during a demo: shown in clear
    this.locks.acquire(sessionId, client);
    this.#publish({ id: `${sessionId}:created`, type: "session.created", provider, sessionId, at: new Date().toISOString(), title: opts.title });
    return { ...s, sessionId, provider };
  }

  /** Streams unified events from this send until its turn ends. Sending while working = steering where supported. */
  async *send(sessionId, message, { client, takeover } = {}) {
    const { p, native, provider } = this.#route(sessionId);
    this.locks.acquire(sessionId, client, { takeover });
    const q = []; let wake = null;
    const onEv = (e) => { if (e.sessionId === sessionId) { q.push(e); wake && wake(); } };
    this.on("event", onEv);
    try {
      const r = await p.startSend(native, message);
      yield { id: `${sessionId}:sent:${Date.now()}`, type: "message.sent", sessionId, provider, at: new Date().toISOString(), turnId: r.turnId };
      const myTurn = r.turnId;
      let deadline = null; // bridge providers: keep a short grace window after the terminal event for late message events
      for (;;) {
        if (!q.length) {
          if (deadline && Date.now() >= deadline) return;
          await new Promise((res) => { wake = res; if (deadline) setTimeout(res, Math.max(0, deadline - Date.now())); });
        }
        wake = null;
        while (q.length) {
          const e = q.shift(); yield e;
          // Turn-scoped providers (claude-code/codex) end on THEIR turn; bridge providers end ~500 ms after the first terminal event.
          if (TERMINAL.has(e.type)) { if (myTurn && (e.turnId === myTurn || e.mergedInto === myTurn)) return; if (!myTurn && !deadline) deadline = Date.now() + 500; }
        }
        if (deadline && Date.now() >= deadline) return;
      }
    } finally { this.off("event", onEv); }
  }

  async steer(sessionId, message, { client } = {}) {
    const { p, native, provider } = this.#route(sessionId);
    if (!CAPABILITIES[provider].canSteer) throw err("NOT_SUPPORTED", `${provider} does not support steering`);
    this.locks.acquire(sessionId, client);
    return p.steer(native, message);
  }
  async interrupt(sessionId, { client } = {}) {
    const { p, native, provider } = this.#route(sessionId);
    if (!CAPABILITIES[provider].canInterrupt) throw err("NOT_SUPPORTED", `${provider} cannot be interrupted`);
    this.locks.acquire(sessionId, client);
    return p.interrupt(native);
  }
  #pendingRequest(requestId) {
    const item = this.attention.list().find((a) => a.requestId === requestId);
    return item;
  }
  async #decide(requestId, decision, opts = {}) {
    const { provider, native } = parseRequestId(requestId);
    const p = this.#provider(provider);
    const item = this.#pendingRequest(requestId);
    if (!item) throw err("NO_SUCH_REQUEST", `no pending request ${requestId} (already resolved or never seen)`);
    this.locks.acquire(item.sessionId, opts.client, { takeover: opts.takeover });
    return p.decide(native, decision, opts, requestId);
  }
  approve(requestId, opts) { return this.#decide(requestId, "approve", opts); }
  deny(requestId, opts) { return this.#decide(requestId, "deny", opts); }
  answerQuestion(requestId, answer, opts = {}) { return this.#decide(requestId, "approve", { ...opts, answer, answers: { _: answer } }); }

  /** Live events, optionally for one session. */
  async *subscribe(sessionId) {
    const q = []; let wake = null;
    const onEv = (e) => { if (!sessionId || e.sessionId === sessionId) { q.push(e); wake && wake(); } };
    this.on("event", onEv);
    try { for (;;) { if (!q.length) await new Promise((r) => (wake = r)); wake = null; while (q.length) yield q.shift(); } }
    finally { this.off("event", onEv); }
  }
  releaseWriter(sessionId, client) { this.locks.release(sessionId, client); }
  /** Let go of a session in its harness (e.g. unload a Codex thread so the Codex app or CLI can open it). */
  async closeSession(sessionId, { client } = {}) { const { p, native } = this.#route(sessionId); this.locks.release(sessionId, client); return p.close ? p.close(native) : { ok: true }; }
}
export { PROVIDERS };
