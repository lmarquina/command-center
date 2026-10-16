// The daemon's wire protocol over a local Unix socket (0600, never the network). One JSON object per line:
//   → {id, method, params}   ← {id, ok, result|error, ms}   ← {kind:"event", ...UnifiedEvent}
// Every mutating call carries params.client ("cli", "web-ui", "g2") for the one-writer-per-session rule.
import fs from "node:fs";
import net from "node:net";

export async function startRpcServer({ core, sockPath, health = {}, checkHealth = async () => [], log = () => {}, onEvent = () => {}, onShutdown = () => {} }) {
  const watchers = new Set();
  const send = (sock, obj) => { if (sock && !sock.destroyed) sock.write(JSON.stringify(obj) + "\n"); };
  core.on("event", (e) => { onEvent(e); for (const w of watchers) send(w, { kind: "event", ...e }); });

  const METHODS = {
    ping: () => ({ pid: process.pid, providers: health }),
    health: () => checkHealth(),
    capabilities: (p) => core.capabilities(p.provider),
    sessions: (p) => core.listSessions(p.query, { providers: p.providers }),
    get: (p) => core.getSession(p.sessionId, { limit: p.limit }),
    status: (p) => core.getStatus(p.sessionId),
    // in presentation mode a request from a not-yet-listed session would be masked by mistake: list first
    attention: async () => { if (core.hasUnknownAttention && core.hasUnknownAttention()) await core.listSessions(); return core.needsAttention(); },
    ack: (p) => core.ack(p.sessionId),
    create: (p) => core.createSession(p),
    steps: (p) => core.stepList(p.sessionId, p),
    stepOpen: (p) => core.stepOpen(p.sessionId, p),
    steer: (p) => core.steer(p.sessionId, p.message, { client: p.client }),
    interrupt: (p) => core.interrupt(p.sessionId, { client: p.client }),
    approve: (p) => core.approve(p.requestId, { client: p.client, takeover: p.takeover }),
    deny: (p) => core.deny(p.requestId, { client: p.client, takeover: p.takeover }),
    answer: (p) => core.answerQuestion(p.requestId, p.answer, { client: p.client }),
    release: (p) => core.releaseWriter(p.sessionId, p.client),
    close: (p) => core.closeSession(p.sessionId, { client: p.client }),
    locks: () => core.locks.list(),
    shutdown: () => { setTimeout(() => onShutdown("shutdown request"), 50); return { stopping: true }; },
  };

  async function handle(sock, { id, method, params = {} }) {
    const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
    try {
      if (method === "watch") { watchers.add(sock); return send(sock, { id, ok: true, result: { watching: true } }); }
      if (method === "send") {
        let last;
        for await (const e of core.send(params.sessionId, params.message, { client: params.client, takeover: params.takeover })) {
          send(sock, { kind: "event", ...e });
          if (/^agent\.(completed|interrupted|failed)$/.test(e.type)) last = e;
          if (params.detach && e.type === "message.sent") return send(sock, { id, ok: true, result: { detached: true, ...e }, ms: ms() });
        }
        return send(sock, { id, ok: true, result: last, ms: ms() });
      }
      if (!METHODS[method]) throw Object.assign(new Error(`unknown method ${method}`), { code: "UNKNOWN_METHOD" });
      send(sock, { id, ok: true, result: await METHODS[method](params), ms: ms() });
    } catch (e) {
      log("error", method, e.code, e.message);
      send(sock, { id, ok: false, error: { code: e.code || "ERROR", message: e.message, holder: e.holder }, ms: ms() });
    }
  }

  if (fs.existsSync(sockPath)) {
    const alive = await new Promise((r) => { const c = net.createConnection(sockPath); c.on("connect", () => { c.end(); r(true); }); c.on("error", () => r(false)); });
    if (alive) throw Object.assign(new Error(`a daemon is already listening on ${sockPath}`), { code: "ALREADY_RUNNING" });
    fs.unlinkSync(sockPath);   // left behind by a crash
  }
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        handle(sock, m);
      }
    });
    sock.on("close", () => watchers.delete(sock)); sock.on("error", () => watchers.delete(sock));
  });
  await new Promise((res, rej) => { server.once("error", rej); server.listen(sockPath, res); });
  fs.chmodSync(sockPath, 0o600);
  return { server, close: () => new Promise((r) => { for (const w of watchers) w.destroy(); server.close(() => { try { fs.unlinkSync(sockPath); } catch {} r(); }); }) };
}
