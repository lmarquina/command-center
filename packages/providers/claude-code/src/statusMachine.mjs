// Explicit per-session status state machine, driven only by adapter-observed lifecycle facts.
// Claude Code 2.1.287 did NOT emit system/session_state_changed in our runs, so turn boundaries come from:
//   client send / unsolicited system/init  → turn start
//   canUseTool callback                    → approval_required | waiting_for_input (AskUserQuestion)
//   decision supplied                      → working (only if no other request is still pending)
//   result message                         → complete | interrupted | failed (turn end)
// Transient events (status, thinking tokens, rate limits, stream events) never change status, so a turn
// cannot flip to idle mid-work (the bug Cowork had after approvals).

export const STATUSES = ["idle", "working", "waiting_for_input", "approval_required", "complete", "interrupted", "failed", "unknown"];

export class StatusMachine {
  constructor(initial = "idle") {
    this.status = initial;
    this.pending = new Map(); // requestId -> kind
    this.inTurn = false;
    this.interruptRequested = false;
  }
  #derive(base) {
    if (this.pending.size) return [...this.pending.values()].includes("tool") ? "approval_required" : "waiting_for_input";
    return base;
  }
  #set(next, out) { if (next !== this.status) { this.status = next; out.push(next); } return out; }

  /** @returns {string[]} status values entered (empty if unchanged) */
  apply(fact) {
    const out = [];
    switch (fact.type) {
      case "turn_start":
        this.inTurn = true; this.interruptRequested = false;
        return this.#set(this.#derive("working"), out);
      case "request_opened":
        this.pending.set(fact.requestId, fact.kind);
        return this.#set(this.#derive("working"), out);
      case "request_closed":
        this.pending.delete(fact.requestId);
        return this.#set(this.#derive(this.inTurn ? "working" : this.status), out);
      case "interrupt_sent":
        this.interruptRequested = true;
        return out;
      case "turn_end": {
        this.inTurn = false;
        this.pending.clear(); // the CLI cancels outstanding requests when a turn ends
        let outcome;
        if (fact.subtype === "success") outcome = "complete";
        else if (this.interruptRequested || String(fact.terminal || "").startsWith("aborted")) outcome = "interrupted"; // observed: aborted_streaming
        else outcome = "failed";
        this.interruptRequested = false;
        return this.#set(outcome, out);
      }
      case "process_exit":
        this.inTurn = false; this.pending.clear();
        return this.#set(fact.error ? "failed" : (this.status === "working" ? "failed" : this.status), out);
      default:
        return out; // transient / unknown facts never move the status
    }
  }
}
