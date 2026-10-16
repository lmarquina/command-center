// Client for agentd's Unix socket: one-shot requests + a long-lived event watch with reconnect.
import net from "node:net";
import path from "node:path";
import { EventEmitter } from "node:events";
import { RUN_DIR } from "@command-center/core/paths.mjs";
import { keepConnected } from "@command-center/core/keepConnected.mjs";

export const AGENTD_SOCK = process.env.AGENTD_SOCK || path.join(RUN_DIR, "agentd.sock");

export class AgentdClient extends EventEmitter {
  constructor(sock = AGENTD_SOCK, { retryMs = 1500 } = {}) { super(); this.sock = sock; this.connected = false; this.retryMs = retryMs; }
  request(method, params = {}, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(this.sock); let buf = "";
      const t = setTimeout(() => { s.destroy(); reject(Object.assign(new Error(`agentd ${method} timed out`), { code: "TIMEOUT" })); }, timeoutMs);
      s.on("error", (e) => { clearTimeout(t); reject(Object.assign(new Error(`agentd not reachable (${e.code})`), { code: "AGENTD_DOWN" })); });
      s.on("connect", () => s.write(JSON.stringify({ id: "1", method, params }) + "\n"));
      s.on("data", (d) => {
        buf += d; let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          let m; try { m = JSON.parse(buf.slice(0, i)); } catch { buf = buf.slice(i + 1); continue; } buf = buf.slice(i + 1);
          if (m.kind === "event") continue; // send() streams events; the UI gets them from the watch instead
          clearTimeout(t); s.end();
          return m.ok ? resolve(m.result) : reject(Object.assign(new Error(m.error.message), { code: m.error.code, holder: m.error.holder }));
        }
      });
    });
  }
  watch() {
    this.sub = keepConnected({
      path: this.sock, retryMs: this.retryMs,
      onConnect: (s) => { this.connected = true; this.emit("status", { connected: true }); s.write(JSON.stringify({ id: "w", method: "watch" }) + "\n"); },
      onMessage: (m) => { if (m.kind === "event") this.emit("event", m); },
      onDown: () => { this.connected = false; this.emit("status", { connected: false }); },
    });
  }
  close() { if (this.sub) this.sub.close(); }
}
