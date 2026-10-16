// Central single-writer policy for the command center.
// - Many readers, one writer per session. The writer is a *client* (e.g. "g2", "web-ui", "cli").
// - A writer lease is taken implicitly on the first mutation and renewed by each mutation; it expires after `ttlMs`
//   of writer inactivity, or is released explicitly. Another client mutating while the lease is live → SESSION_LOCKED
//   (unless it passes takeover:true, which is logged as an event by the caller).
// - Provider-level locks still apply underneath (Claude Code file lock, Codex native writer lock).
export class LockManager {
  constructor({ ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) { this.ttlMs = ttlMs; this.now = now; this.leases = new Map(); }
  holder(sessionId) {
    const l = this.leases.get(sessionId);
    if (l && this.now() - l.renewedAt > this.ttlMs) { this.leases.delete(sessionId); return null; }
    return l || null;
  }
  /** Throws SESSION_LOCKED if another live writer holds the session. */
  acquire(sessionId, owner, { takeover = false } = {}) {
    if (!owner) throw Object.assign(new Error("mutations require a client id"), { code: "NO_CLIENT_ID" });
    const h = this.holder(sessionId);
    if (h && h.owner !== owner && !takeover) throw Object.assign(new Error(`session ${sessionId} is being written by ${h.owner} (since ${new Date(h.acquiredAt).toISOString()})`), { code: "SESSION_LOCKED", holder: h });
    const t = this.now();
    const lease = h && h.owner === owner ? { ...h, renewedAt: t } : { sessionId, owner, acquiredAt: t, renewedAt: t, tookOverFrom: h && h.owner !== owner ? h.owner : undefined };
    this.leases.set(sessionId, lease);
    return lease;
  }
  release(sessionId, owner) { const h = this.holder(sessionId); if (h && (!owner || h.owner === owner)) this.leases.delete(sessionId); }
  list() { return [...this.leases.keys()].map((k) => this.holder(k)).filter(Boolean); }
}
