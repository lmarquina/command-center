// Cowork (claude.ai) and ChatGPT (chatgpt.com) via the Chrome extension's native host socket.
// The native host is spawned by Chrome; session-core is a client of its Unix socket (no network).
import net from "node:net";
import path from "node:path";
import { RUN_DIR } from "@command-center/core/paths.mjs";
import { fromBridgeEvent } from "@command-center/core/events.mjs";
import { keepConnected } from "@command-center/core/keepConnected.mjs";

// Unix socket of the extension's native-messaging host (repo-root run/, gitignored).
const SOCK = process.env.WEB_BRIDGE_SOCK || path.join(RUN_DIR, "bridge.sock");

export class WebBridgeClient {
  constructor(sock = SOCK) { this.sock = sock; this.listeners = new Set(); this.connected = false; }
  async request(method, params = {}, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.sock); let buf = "";
      const t = setTimeout(() => { s.destroy(); reject(Object.assign(new Error(`web bridge ${method} timed out`), { code: "TIMEOUT" })); }, timeoutMs);
      s.on("error", (e) => { clearTimeout(t); reject(Object.assign(new Error(`web bridge not reachable (${e.code}); is Chrome running with the extension?`), { code: "BRIDGE_DOWN" })); });
      s.on("connect", () => s.write(JSON.stringify({ id: "1", method, params }) + "\n"));
      s.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i < 0) return; const m = JSON.parse(buf.slice(0, i)); clearTimeout(t); s.end(); m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error.message), { code: m.error.code, details: m.error.details })); });
    });
  }
  /** Long-lived event subscription with reconnect (the host restarts with Chrome/extension). */
  subscribe() {
    this.sub = keepConnected({
      path: this.sock, retryMs: 2000,
      onConnect: (s) => { this.connected = true; s.write(JSON.stringify({ id: "sub", method: "events.subscribe" }) + "\n"); },
      onMessage: (m) => { if (m.type === "event") for (const ev of fromBridgeEvent(m)) for (const l of this.listeners) l(ev); },
      onDown: () => { this.connected = false; },
    });
  }
  close() { if (this.sub) this.sub.close(); }
}

export class WebBridgeProvider {
  /** @param {"cowork"|"chatgpt"} name */
  constructor(name, client, { launcher } = {}) {
    this.name = name; this.client = client; this.launcher = launcher;
    this.listCache = null; this.listAt = 0; this.listInflight = null;
    // keep the session list current from pushed "sessions.changed" events (no polling on every screen)
    if (client && client.listeners) client.listeners.add((ev) => { if (ev.provider === this.name && ev.type === "sessions.changed") { this.listCache = ev.sessions; this.listAt = Date.now(); } });
  }
  onEvent(cb) { const f = (ev) => ev.provider === this.name && cb(ev); this.client.listeners.add(f); return () => this.client.listeners.delete(f); }
  p(params = {}) { return this.name === "chatgpt" ? { ...params, provider: "chatgpt" } : params; }
  tid(nativeId) { return this.name === "chatgpt" ? `chatgpt:${nativeId}` : nativeId; }
  async start() { return this.client.request("bridge.doctor", this.p()); }
  async list(query) {
    // Pushed list if we have one from the last 5 minutes; otherwise ask the bridge once (single-flight, 15 s cap).
    if (!this.listCache || Date.now() - this.listAt > 5 * 60e3) {
      this.listInflight = this.listInflight || this.client.request("session.list", this.p(), 15000).then((r) => { this.listCache = r.sessions; this.listAt = Date.now(); }).finally(() => { this.listInflight = null; });
      if (!this.listCache) await this.listInflight; else this.listInflight.catch(() => {});
    }
    const r = { sessions: this.listCache || [] };
    return r.sessions.filter((s) => this.name === "chatgpt" ? s.kind === "chatgpt" : s.kind !== "chatgpt")
      .map((s) => ({ provider: this.name, nativeId: this.name === "chatgpt" ? s.sessionId.slice(8) : s.sessionId, title: s.title, url: s.url, group: s.group, project: s.project, status: s.status || "unknown", updatedAt: s.updatedAt, live: false }))
      .filter((s) => !query || (s.title || "").toLowerCase().includes(query.toLowerCase()));
  }
  async get(nativeId, { limit = 20 } = {}) {
    const r = await this.client.request("session.read", this.p({ sessionId: this.tid(nativeId), limit }), 20000);
    const st = await this.client.request("session.status", this.p({ sessionId: this.tid(nativeId) }), 20000);
    return { provider: this.name, nativeId, title: r.identity && r.identity.title, status: st.status, environment: st.environment, question: st.question, approval: st.approval,
      messages: r.messages.map((m) => ({ id: m.turnKey || m.messageId || `${m.index}`, role: m.role, text: m.text, tools: m.tools, toolGroups: m.toolGroups, inProgress: m.inProgress })), totalMessages: r.total, rendered: r.rendered };
  }
  async status(nativeId) { const st = await this.client.request("session.status", this.p({ sessionId: this.tid(nativeId) })); return { status: st.status, question: st.question, approval: st.approval }; }
  async create(o) {
    if (this.name === "cowork") {
      // New Cowork tasks bound to this Mac start in Claude Desktop (POC 7); the Chrome bridge then reads/continues them.
      if (!this.launcher) throw Object.assign(new Error("creating Cowork tasks needs the Claude Desktop launcher"), { code: "NOT_SUPPORTED" });
      const r = await this.launcher.create({ firstMessage: o.firstMessage || o.message, cwd: o.cwd, project: o.project, projectId: o.projectId });
      return { nativeId: r.nativeId, status: "working", environment: r.environment, target: r.target, via: "desktop", ms: r.ms };
    }
    const r = await this.client.request("session.new", this.p({ message: o.firstMessage || o.message, force: o.force })); return { nativeId: r.sessionId.slice(8), status: r.status }; }
  // Cowork step groups, read on demand (read-only; the bridge expands, reads, and collapses again).
  async stepList(nativeId, { turnKey, group }) { return this.client.request("session.steps", this.p({ sessionId: this.tid(nativeId), turnKey, group }), 60000); }
  async stepOpen(nativeId, { turnKey, group, stepKey }) { return this.client.request("session.stepOpen", this.p({ sessionId: this.tid(nativeId), turnKey, group, stepKey }), 60000); }
  async startSend(nativeId, message) { const r = await this.client.request("session.send", this.p({ sessionId: this.tid(nativeId), message })); return { turnId: null, via: r.via, messageIndex: r.messageIndex }; }
  async steer(nativeId, message) { if (this.name === "chatgpt") throw Object.assign(new Error("ChatGPT has no steering"), { code: "NOT_SUPPORTED" }); return this.startSend(nativeId, message); }
  async interrupt(nativeId) { return this.client.request("session.stop", this.p({ sessionId: this.tid(nativeId) })); }
  /** Bridge request ids are "<sessionNative>#approval" / "#question": the card currently shown for that session. */
  async decide(nativeReqId, decision, opts = {}) {
    const [sid, kind] = nativeReqId.split("#");
    if (kind === "question") {
      if (decision !== "approve") throw Object.assign(new Error("Cowork questions are answered, not denied; send a message instead"), { code: "NOT_SUPPORTED" });
      return this.client.request("session.answer", this.p({ sessionId: sid, option: opts.answer ?? Object.values(opts.answers || {})[0] }));
    }
    return this.client.request(decision === "approve" ? "session.approve" : "session.deny", this.p({ sessionId: sid }));
  }
  close() {}
  stop() {}
}
