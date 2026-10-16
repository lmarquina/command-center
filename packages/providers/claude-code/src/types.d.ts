// Provider-neutral session-control model shared with the Cowork bridge (see ../../../CLAUDE_CODE_VS_COWORK.md).
// Implementation is plain ESM JavaScript (Node 18, no build step); this file documents the contract.

export type SessionStatus =
  | "idle" | "working" | "waiting_for_input" | "approval_required"
  | "complete" | "interrupted" | "failed" | "unknown";

export interface SessionSummary {
  provider: "claude-code" | "cowork";
  sessionId: string;            // canonical identity (Claude Code: transcript UUID; Cowork: cse_… / chat:<uuid>)
  title: string;                // display only, never identity
  cwd?: string;
  gitBranch?: string;
  createdAt?: string;
  updatedAt?: string;
  tag?: string;
  status: SessionStatus;        // live status if this adapter is running the session, else "idle"
  live: boolean;                // true while this adapter holds a running process for the session
}

export interface SessionMessageView {
  id: string;                   // transcript entry uuid
  role: "user" | "assistant" | "tool" | "system";
  text?: string;
  tool?: { name: string; id: string; input?: unknown };
  toolResult?: { toolUseId: string; isError: boolean; preview?: string };
}

export interface SessionDetail extends SessionSummary {
  messages: SessionMessageView[];
  totalMessages: number;
  pendingApprovals: ApprovalRequest[];
}

export interface CreateSessionOptions { cwd: string; title?: string; model?: string; firstMessage?: string }

export interface ApprovalRequest {
  requestId: string;            // provider-native request id (Claude Code: control request_id)
  sessionId: string;
  provider: "claude-code" | "cowork";
  kind: "tool" | "question";
  tool?: string;
  toolUseId?: string;
  description: string;
  question?: { text: string; header?: string; options: string[]; multiSelect?: boolean }[];
  details?: unknown;
  createdAt: string;
}

export type AgentEvent = { id: string; sessionId: string; seq: number; at: string } & (
  | { type: "status"; value: SessionStatus; reason?: string }
  | { type: "turn_started"; turnId: string; origin: "client" | "unsolicited" }
  | { type: "steer_accepted"; turnId: string; intoTurn: string }   // message sent mid-turn was absorbed into the running turn
  | { type: "assistant_delta"; messageId: string; block: number; offset: number; text: string }
  | { type: "assistant_message"; messageId: string; block: number; text: string }
  | { type: "tool_call"; tool: string; toolUseId: string; details?: unknown }
  | { type: "tool_result"; toolUseId: string; isError: boolean; preview?: string }
  | { type: "approval_required"; request: ApprovalRequest }
  | { type: "approval_resolved"; requestId: string; decision: "approve" | "deny" | "answered" | "cancelled" }
  | { type: "question"; request: ApprovalRequest }
  | { type: "turn_complete"; turnId: string; outcome: "complete" | "interrupted" | "failed"; result?: string; costUsd?: number; durationMs?: number; mergedInto?: string }
  | { type: "error"; message: string }
);

export interface AgentSessionAdapter {
  provider: string;
  listSessions(query?: string): Promise<SessionSummary[]>;
  getSession(sessionId: string, opts?: { limit?: number }): Promise<SessionDetail>;
  createSession(options: CreateSessionOptions): Promise<SessionDetail>;
  sendMessage(sessionId: string, message: string): AsyncIterable<AgentEvent>;
  refreshSession(sessionId: string): Promise<SessionDetail>;
  interrupt?(sessionId: string): Promise<{ interrupted: boolean }>;
  listApprovals?(): ApprovalRequest[];
  respondToApproval?(requestId: string, decision: "approve" | "deny", opts?: { answers?: Record<string, string>; message?: string }): Promise<void>;
}
