// Sanitized SDK message sequences modelled on live runs (2026-10-01, CLI 2.1.287). No private content.
const S = "11111111-1111-4111-8111-111111111111";
export const SID = S;
const init = (uuid) => ({ type: "system", subtype: "init", session_id: S, uuid });
const replay = (uuid, text) => ({ type: "user", isReplay: true, uuid, session_id: S, message: { role: "user", content: text } });
const se = (event) => ({ type: "stream_event", session_id: S, event });
const result = (uuid, subtype, r, terminal) => ({ type: "result", subtype, result: r, terminal_reason: terminal, uuid, session_id: S, is_error: subtype !== "success" });

// Simple streamed reply to a client turn.
export const simpleTurn = (clientUuid) => [
  init("init-1"), replay(clientUuid, "count"),
  se({ type: "message_start", message: { id: "msg_1" } }),
  se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "1\n2" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\n3" } }),
  { type: "assistant", session_id: S, message: { id: "msg_1", content: [{ type: "text", text: "1\n2\n3" }] } },
  se({ type: "content_block_stop", index: 0 }),
  result("res-1", "success", "1\n2\n3", "completed"),
];

// Background-task notification produces an unsolicited turn (no replay) before the client's turn.
export const unsolicitedThenClient = (clientUuid) => [
  { type: "system", subtype: "task_notification", session_id: S, uuid: "tn-1" },
  init("init-u"), result("res-u", "success", "", "completed"),
  init("init-c"), replay(clientUuid, "hi"),
  { type: "assistant", session_id: S, message: { id: "msg_2", content: [{ type: "text", text: "HI" }] } },
  result("res-c", "success", "HI", "completed"),
];

// Steering: second client message is replayed mid-turn (at a tool boundary) and merged.
export const steeredTurn = (first, steer) => [
  init("init-s"), replay(first, "read three files"),
  { type: "assistant", session_id: S, message: { id: "msg_3", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a" } }] } },
  { type: "user", session_id: S, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "A" }] } },
  replay(steer, "only a"),
  { type: "assistant", session_id: S, message: { id: "msg_4", content: [{ type: "text", text: "only a" }] } },
  result("res-s", "success", "only a", "completed"),
];

// Interrupted streaming turn.
export const interruptedTurn = (clientUuid) => [
  init("init-i"), replay(clientUuid, "story"),
  se({ type: "message_start", message: { id: "msg_5" } }),
  se({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Once" } }),
  result("res-i", "error_during_execution", "", "aborted_streaming"),
];

// CLI reports a different session id than requested (must fail closed).
export const wrongSession = () => [{ type: "system", subtype: "init", session_id: "22222222-2222-4222-8222-222222222222", uuid: "x" }];
