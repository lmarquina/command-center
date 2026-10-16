import { AdapterProvider } from "@command-center/core/adapterProvider.mjs";

export class ClaudeCodeProvider extends AdapterProvider {
  constructor(adapter) { super("claude-code", adapter); this.wire(); }
  async start() { return { ok: true }; }
  /** Returns the client turn id; events flow through the bus. Mid-turn sends are steering (merged turn). */
  async startSend(nativeId, message) { return { turnId: await this.adapter.send(nativeId, message) }; }
  async steer(nativeId, message) { return this.startSend(nativeId, message); }
}
