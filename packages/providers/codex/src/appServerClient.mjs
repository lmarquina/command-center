// Minimal JSON-RPC client for `codex app-server` over stdio (one JSON object per line).
// Handles: client→server requests, server notifications, server→client requests (approvals / user input).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { EventEmitter } from "node:events";

// The Codex Desktop app moved its bundled CLI between versions (Resources/codex → Resources/codex-cli/bin/codex
// in 26.930), so resolve at startup instead of hard-coding.
export function resolveCodexBinary() {
  const candidates = [
    process.env.CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try { return execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim(); } catch {}
  throw Object.assign(new Error("codex binary not found (set CODEX_BIN)"), { code: "CODEX_NOT_FOUND" });
}

export class AppServerClient extends EventEmitter {
  constructor({ bin = resolveCodexBinary(), args = [], log = () => {} } = {}) {
    super();
    this.bin = bin; this.args = args; this.log = log;
    this.nextId = 1; this.pending = new Map(); this.closed = false;
  }
  async start(clientInfo = { name: "command_center_poc", title: "Command Center POC", version: "0.1" }) {
    this.version = execFileSync(this.bin, ["--version"], { encoding: "utf8" }).trim();
    this.proc = spawn(this.bin, ["app-server", ...this.args], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { this.log("bad line", line.slice(0, 200)); continue; }
        if (m.id !== undefined && m.method) this.emit("serverRequest", m);            // needs a reply
        else if (m.id !== undefined) { const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code, rpc: true })) : p.resolve(m.result); } }
        else if (m.method) this.emit("notification", m);
      }
    });
    this.proc.stderr.on("data", (d) => this.log("codex-stderr", d.toString().slice(0, 300)));
    this.proc.on("exit", (code, signal) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(Object.assign(new Error(`app-server exited (${signal || code})`), { code: "APP_SERVER_EXITED" }));
      this.pending.clear();
      this.emit("exit", { code, signal });
    });
    this.proc.on("error", (e) => this.emit("exit", { error: e.message }));
    const init = await this.request("initialize", { clientInfo, capabilities: null });
    this.notify("initialized");
    return init;
  }
  request(method, params) {
    if (this.closed) return Promise.reject(Object.assign(new Error("app-server not running"), { code: "APP_SERVER_EXITED" }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify(params === undefined ? { method } : { method, params }) + "\n"); }
  reply(id, result) { this.proc.stdin.write(JSON.stringify({ id, result }) + "\n"); }
  stop() { if (this.proc && !this.closed) this.proc.kill("SIGTERM"); }
}
