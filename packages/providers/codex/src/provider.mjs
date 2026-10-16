import { AdapterProvider } from "@command-center/core/adapterProvider.mjs";

export class CodexProvider extends AdapterProvider {
  constructor(adapter) { super("codex", adapter); this.wire(); }
  async start() { return this.adapter.start(); }
  async startSend(nativeId, message) {
    const it = this.adapter.sendMessage(nativeId, message)[Symbol.asyncIterator]();
    let first = await it.next();
    while (!first.done && first.value.type !== "sent") first = await it.next();
    (async () => { try { for (;;) { const r = await it.next(); if (r.done) break; } } catch {} })(); // drain; events reach the bus via the emitter
    return { turnId: first.value && first.value.turnId, steered: first.value && first.value.steered };
  }
  async steer(nativeId, message) { return this.adapter.steer(nativeId, message); }
}
