// Capability sets: only what was observed in the POC test matrices. Do not fake parity.
export const CAPABILITIES = {
  "claude-code": {
    canStream: true, streamGranularity: "token", canSteer: true, steerSemantics: "injected at next tool boundary (merged into running turn)",
    canInterrupt: true, canApprove: true, canAnswerStructuredQuestions: true, canCreateSession: true,
    canUseComputer: false, canUseBrowser: false, canAccessLocalFiles: true, canCreateArtifacts: true,
    requiresUIBridge: false, historyComplete: true, nativeWriterLock: false, transport: "Claude Agent SDK (official)",
  },
  codex: {
    canStream: true, streamGranularity: "token", canSteer: true, steerSemantics: "turn/steer with expectedTurnId (applied after current message)",
    canInterrupt: true, canApprove: true, canAnswerStructuredQuestions: true, structuredQuestionsNote: "requires default_mode_request_user_input (under development)",
    canCreateSession: true, canUseComputer: false, canUseBrowser: false, canAccessLocalFiles: true, canCreateArtifacts: true,
    requiresUIBridge: false, historyComplete: true, nativeWriterLock: true, transport: "Codex App Server (official)",
    note: "threads opened in Codex Desktop are read-only while Desktop runs (WRITER_BUSY)",
  },
  cowork: {
    canStream: true, streamGranularity: "coalesced (≤1 update/1.5s)", canSteer: true, steerSemantics: "message while working changes direction",
    canInterrupt: true, canApprove: true, canAnswerStructuredQuestions: true, canCreateSession: true, createVia: "via Claude Desktop on this Mac: no folder, or an existing project",
    canUseComputer: true, canUseBrowser: true, canAccessLocalFiles: true, canCreateArtifacts: true,
    requiresUIBridge: true, historyComplete: false, nativeWriterLock: false, transport: "Chrome extension on claude.ai (UI bridge; user-accepted terms risk)",
    note: "new tasks start in Claude Desktop bound to this Mac (window on the current Space; folder pre-approved with Always allow + Don't ask again); continuing goes through the Chrome bridge",
  },
  chatgpt: {
    canStream: true, streamGranularity: "completion-only in background tabs", canSteer: false, canInterrupt: true,
    canApprove: false, canAnswerStructuredQuestions: false, canCreateSession: true,
    canUseComputer: false, canUseBrowser: false, canAccessLocalFiles: false, canCreateArtifacts: true,
    requiresUIBridge: true, historyComplete: false, nativeWriterLock: false, transport: "Chrome extension on chatgpt.com (UI bridge; user-accepted terms risk)",
    note: "ChatGPT Work/Codex threads are served by the codex provider",
  },
};
