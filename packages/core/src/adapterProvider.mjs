// Base for providers backed by an in-process adapter (Claude Code, Codex). Those adapters already speak the
// same native event vocabulary; fromAdapterEvent() maps it onto unified events.
import { fromAdapterEvent } from "./events.mjs";

export class AdapterProvider {
  constructor(name, adapter) { this.name = name; this.adapter = adapter; this.pending = new Map(); this.listeners = new Set(); }
  onEvent(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  wire() { this.adapter.on("event", (e) => { for (const u of fromAdapterEvent(this.name, e, this.pending)) for (const l of this.listeners) l(u); }); }
  async list(query) { return (await this.adapter.listSessions(query)).map((s) => ({ ...s, nativeId: s.sessionId })); }
  async get(nativeId, o) { return { ...(await this.adapter.getSession(nativeId, o)), nativeId }; }
  status(nativeId) { return this.adapter.getStatus(nativeId); }
  async create(o) { const s = await this.adapter.createSession(o); return { ...s, nativeId: s.sessionId }; }
  async interrupt(nativeId) { return this.adapter.interrupt(nativeId); }
  async decide(nativeReqId, decision, opts, fullReqId) {
    const p = this.pending.get(fullReqId); if (p) p.decision = decision === "approve" ? "approve" : "deny";
    return this.adapter.respondToApproval(nativeReqId, decision, opts);
  }
  close(nativeId) { return this.adapter.closeSession(nativeId); }
  stop() { return this.adapter.shutdown(); }
}
