// NeedsAttention: the short list the user must act on (maps 1:1 to G2 notifications later).
// Kinds: approval | question | failure | review (completed work not yet seen).
export class AttentionBoard {
  constructor() { this.items = new Map(); } // key -> item
  apply(ev) {
    const put = (key, item) => this.items.set(key, { ...item, key, sessionId: ev.sessionId, provider: ev.provider, at: ev.at });
    switch (ev.type) {
      case "approval.requested": put(`req:${ev.request.requestId}`, { kind: "approval", requestId: ev.request.requestId, text: ev.request.description }); break;
      case "question.requested": put(`req:${ev.request.requestId}`, { kind: "question", requestId: ev.request.requestId, text: ev.request.description, options: (ev.request.question && ev.request.question[0] && ev.request.question[0].options) || [] }); break;
      case "approval.approved": case "approval.denied": case "approval.cancelled": case "question.answered":
        this.items.delete(`req:${ev.requestId}`);
        if (ev.provider === "cowork" || ev.provider === "chatgpt") this.#clearBridgeReq(ev.sessionId); break;
      case "agent.failed": put(`fail:${ev.sessionId}`, { kind: "failure", text: ev.error ? JSON.stringify(ev.error).slice(0, 120) : (ev.result || "Agent failed") }); break;
      case "agent.completed": put(`review:${ev.sessionId}`, { kind: "review", text: (ev.result || "Finished").slice(0, 160) }); this.#clearBridgeReq(ev.sessionId); break;
      case "agent.started": this.items.delete(`fail:${ev.sessionId}`); this.items.delete(`review:${ev.sessionId}`); break;
      case "status.changed":
        // A turn that leaves the waiting/approval state resolves bridge-side requests (no per-request ids there).
        if (["working", "idle", "complete", "interrupted"].includes(ev.status)) this.#clearBridgeReq(ev.sessionId);
        break;
    }
  }
  #clearBridgeReq(sessionId) { for (const [k, v] of this.items) if (v.sessionId === sessionId && (v.provider === "cowork" || v.provider === "chatgpt") && (v.kind === "approval" || v.kind === "question")) this.items.delete(k); }
  /** Mark reviewed (e.g. user opened the session). */
  ack(sessionId) { this.items.delete(`review:${sessionId}`); this.items.delete(`fail:${sessionId}`); }
  list() { const order = { approval: 0, question: 1, failure: 2, review: 3 }; return [...this.items.values()].sort((a, b) => order[a.kind] - order[b.kind] || String(b.at).localeCompare(String(a.at))); }
}
