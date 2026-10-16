// Cowork Bridge wire protocol (shared by service worker and content script). Classic script.
// Request:  { id, method, params }
// Response: { id, ok: true, result } | { id, ok: false, error: { code, message, details? } }
// Event:    { type: "event", event, sessionId, ...data, at }
(function (root) {
  root.CoworkProtocol = {
    HOST_NAME: "com.commandcenter.bridge",
    METHODS: [
      "bridge.ping", "bridge.doctor",
      "session.list", "session.open", "session.read", "session.status",
      "session.send", "session.answer", "session.approve", "session.deny", "session.stop",
      "session.inventory", "bridge.health", "demo.window", "demo.close", "debug.snapshot",
    ],
    STATUSES: ["idle", "working", "waiting_for_input", "approval_required", "interrupted", "complete", "failed", "unknown"],
    EVENTS: ["session.statusChanged", "session.messageAdded", "session.messageUpdated", "session.approvalRequested", "session.questionRequested", "session.completed", "session.interrupted", "session.changed", "bridge.tabReady"],
    ERR: {
      NO_TAB: "NO_CLAUDE_TAB",
      IDENTITY: "IDENTITY_UNVERIFIED",
      NOT_FOUND: "CONTROL_NOT_FOUND",
      LOW_CONF: "SAFE_ACTION_ABORTED",
      STATE: "INVALID_STATE",
      VERIFY: "POSTCONDITION_FAILED",
      TIMEOUT: "TIMEOUT",
      UNKNOWN_METHOD: "UNKNOWN_METHOD",
      DEGRADED: "BRIDGE_READ_ONLY",
    },
  };
})(globalThis);
