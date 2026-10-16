// SDKMessage → provider-neutral AgentEvent payloads, with deterministic event ids for de-duplication.
// Id scheme (stable across replays/reconnects because it only uses native ids and content offsets):
//   assistant_delta   d:<api message id>:<block index>:<char offset>
//   assistant_message m:<api message id>:<block index>
//   tool_call         t:<tool_use id>
//   tool_result       r:<tool_use id>
//   turn_complete     c:<result uuid>
// Status, approval and turn events get ids from the adapter (request ids / turn ids).

export class EventNormalizer {
  constructor() {
    this.blocks = new Map(); // `${msgId}:${index}` -> { type, text }
    this.currentMsgId = null;
  }

  /** @returns {Array<object>} event payloads (without sessionId/seq/at), each with a deterministic id */
  normalize(m) {
    const out = [];
    if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "message_start") this.currentMsgId = e.message && e.message.id;
      else if (e.type === "content_block_start") this.blocks.set(`${this.currentMsgId}:${e.index}`, { type: e.content_block.type, text: "" });
      else if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta") {
        const k = `${this.currentMsgId}:${e.index}`;
        const b = this.blocks.get(k) || { type: "text", text: "" };
        const offset = b.text.length;
        b.text += e.delta.text;
        this.blocks.set(k, b);
        out.push({ id: `d:${k}:${offset}`, type: "assistant_delta", messageId: this.currentMsgId, block: e.index, offset, text: e.delta.text });
      }
      return out;
    }
    if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
      // The CLI emits one `assistant` message per content block, sharing message.id; index within the
      // API message is recovered from the streamed blocks when available, else from position.
      const msgId = m.message.id;
      m.message.content.forEach((c, i) => {
        const idx = this.#blockIndexFor(msgId, c, i);
        if (c.type === "text" && c.text) out.push({ id: `m:${msgId}:${idx}`, type: "assistant_message", messageId: msgId, block: idx, text: c.text });
        if (c.type === "tool_use") out.push({ id: `t:${c.id}`, type: "tool_call", tool: c.name, toolUseId: c.id, details: { input: c.input } });
      });
      return out;
    }
    if (m.type === "user" && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type === "tool_result") {
          const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("") : "";
          out.push({ id: `r:${c.tool_use_id}`, type: "tool_result", toolUseId: c.tool_use_id, isError: !!c.is_error, preview: text.slice(0, 300) });
        }
      }
      return out;
    }
    return out;
  }

  #blockIndexFor(msgId, content, fallback) {
    for (const [k, b] of this.blocks) {
      if (!k.startsWith(msgId + ":")) continue;
      if (content.type === "text" && b.type === "text" && b.text === content.text) return Number(k.split(":").pop());
      if (content.type === "tool_use" && b.type === "tool_use") { /* tool blocks are keyed by tool_use id instead */ }
    }
    return fallback;
  }
}
