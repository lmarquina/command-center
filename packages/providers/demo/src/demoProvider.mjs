// A provider with made-up sessions, for demos and recordings: it behaves like the real ones (statuses, approvals,
// streamed replies, new sessions) without touching any real account. Enabled with config `demo: true`.
import { randomUUID } from "node:crypto";
import { sessionIdFor, requestIdFor } from "@command-center/core/ids.mjs";
import { demoAnswer, demoReply } from "./world.mjs";

let seq = 0;
const nextId = () => `demo-${Date.now()}-${++seq}`;

export class DemoProvider {
  /** @param {string} name  harness this stands in for @param {object[]} sessions from demoWorld() @param {{pace?: number}} o */
  constructor(name, sessions, { pace = 1 } = {}) {
    this.name = name; this.listeners = new Set(); this.pace = pace;
    this.sessions = new Map(sessions.map((s) => [s.id, { ...s, messages: s.messages.map(([role, text]) => ({ role, text })) }]));
  }
  onEvent(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  #emit(native, type, extra = {}) {
    const ev = { id: `${this.name}:${nextId()}`, type, provider: this.name, sessionId: sessionIdFor(this.name, native), at: new Date().toISOString(), ...extra };
    for (const l of this.listeners) l(ev);
  }
  #later(ms, fn) { setTimeout(fn, ms * this.pace); }

  async start() {
    // replay the live state, so the attention list and "working" counts match the fixture
    this.#later(50, () => {
      for (const s of this.sessions.values()) {
        if (s.status === "working") this.#emit(s.id, "agent.started");
        if (s.request) this.#emit(s.id, "approval.requested", { request: { requestId: requestIdFor(this.name, s.request.id), sessionId: sessionIdFor(this.name, s.id), provider: this.name, kind: "tool", description: s.request.text, createdAt: new Date().toISOString() } });
      }
    });
    return { ok: true, demo: true };
  }
  async stop() {}

  async list(query) {
    return [...this.sessions.values()].map((s) => ({ nativeId: s.id, title: s.title, status: s.status, updatedAt: s.updatedAt, project: s.project, cwd: s.project ? `~/Demo/${s.project}` : undefined }))
      .filter((s) => !query || s.title.toLowerCase().includes(String(query).toLowerCase()));
  }
  #get(native) { const s = this.sessions.get(native); if (!s) throw Object.assign(new Error(`no demo session ${native}`), { code: "NOT_FOUND" }); return s; }
  async get(native, { limit = 20 } = {}) {
    const s = this.#get(native);
    return { nativeId: native, title: s.title, status: s.status, project: s.project, messages: s.messages.slice(-limit), totalMessages: s.messages.length };
  }
  async status(native) { const s = this.#get(native); return { status: s.status }; }

  async create({ firstMessage, title, project } = {}) {
    const id = this.name === "cowork" ? `cse_01Demo${randomUUID().replace(/-/g, "").slice(0, 16)}` : randomUUID();
    const s = { id, title: title || String(firstMessage || "New session").replace(/[.?!]+$/, "").slice(0, 48), project, status: "working", updatedAt: new Date().toISOString(), messages: [] };
    this.sessions.set(id, s);
    if (firstMessage) this.#turn(s, firstMessage, this.name === "chatgpt" ? demoAnswer(firstMessage) : demoReply(firstMessage));
    return { nativeId: id, title: s.title };
  }
  /** User message (if any) → working → streamed reply → done (or idle for chat). */
  #turn(s, message, reply) {
    const turnId = nextId();
    if (message) s.messages.push({ role: "user", text: message });
    s.status = "working"; s.updatedAt = new Date().toISOString();
    this.#emit(s.id, "agent.started", { turnId });
    this.#emit(s.id, "status.changed", { status: "working", turnId });
    const words = reply.split(" "); let i = 0;
    const step = () => {
      i = Math.min(words.length, i + 4);
      this.#emit(s.id, "agent.output.delta", { turnId, text: words.slice(0, i).join(" ") });
      if (i < words.length) return this.#later(250, step);
      s.messages.push({ role: "assistant", text: reply }); s.status = this.name === "chatgpt" ? "idle" : "complete"; s.updatedAt = new Date().toISOString();
      this.#emit(s.id, "agent.output.complete", { turnId, text: reply, final: true });
      this.#emit(s.id, "agent.completed", { turnId, result: reply });
      this.#emit(s.id, "status.changed", { status: s.status, turnId });
    };
    this.#later(this.name === "chatgpt" ? 1200 : 2500, step);
    return turnId;
  }
  async startSend(native, message) { const s = this.#get(native); return { turnId: this.#turn(s, message, this.name === "chatgpt" ? demoAnswer(message) : demoReply(message)) }; }
  async steer(native, message) { return this.startSend(native, message); }
  async interrupt(native) { const s = this.#get(native); s.status = "interrupted"; this.#emit(native, "agent.interrupted"); this.#emit(native, "status.changed", { status: "interrupted" }); return { ok: true }; }
  async decide(nativeReqId, decision) {
    const s = [...this.sessions.values()].find((x) => x.request && x.request.id === nativeReqId);
    if (!s) throw Object.assign(new Error(`no demo request ${nativeReqId}`), { code: "NO_SUCH_REQUEST" });
    const requestId = requestIdFor(this.name, nativeReqId); delete s.request;
    if (decision !== "approve") { this.#emit(s.id, "approval.denied", { requestId }); s.status = "idle"; this.#emit(s.id, "status.changed", { status: "idle" }); return { ok: true }; }
    this.#emit(s.id, "approval.approved", { requestId });
    this.#turn(s, null, "Dry run passed: 14 endpoints migrated, 0 errors. Ready to merge.");   // an approval is not a message
    return { ok: true };
  }
  close() {}
}
