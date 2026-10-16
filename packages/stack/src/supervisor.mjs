// Keeps a set of long-running services alive: starts them in order, restarts one that exits (with a growing
// delay so a broken service cannot spin), and stops them all together. No shell: commands are argv arrays.
// Each service runs in its own process group, so stopping it also stops whatever it started (uv → python,
// the simulator's launcher → its native app).
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export class Supervisor extends EventEmitter {
  /**
   * @param {object} o
   * @param {{name:string, cmd:string, args?:string[], cwd?:string, env?:object}[]} o.services  started in this order
   * @param {string} [o.logDir]     each service's stdout+stderr goes to <logDir>/<name>.log
   * @param {number} [o.minDelayMs] first restart delay; doubles per quick failure up to maxDelayMs
   * @param {number} [o.stableMs]   a run at least this long resets the delay
   */
  constructor({ services, logDir, minDelayMs = 500, maxDelayMs = 30000, stableMs = 10000, killAfterMs = 5000, spawn = nodeSpawn }) {
    super();
    Object.assign(this, { logDir, minDelayMs, maxDelayMs, stableMs, killAfterMs, spawn, stopping: false });
    this.state = new Map(services.map((s) => [s.name, { spec: s, child: null, restarts: 0, delay: minDelayMs, timer: null, startedAt: 0 }]));
  }

  start() { for (const name of this.state.keys()) this.#launch(name); return this; }

  #launch(name) {
    const st = this.state.get(name), { spec } = st;
    let out = "ignore";
    if (this.logDir) { fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 }); out = fs.openSync(path.join(this.logDir, `${name}.log`), "a", 0o600); }
    const child = this.spawn(spec.cmd, spec.args || [], { cwd: spec.cwd, env: { ...process.env, ...(spec.env || {}) }, stdio: ["ignore", out, out], detached: true });
    if (typeof out === "number") fs.closeSync(out);
    st.child = child; st.startedAt = Date.now();
    this.emit("started", { name, pid: child.pid });
    const onGone = (code, signal) => {
      if (st.child !== child) return;          // "error" and "exit" can both fire: handle each child once
      st.child = null;
      this.emit("exited", { name, code, signal });
      if (this.stopping) return;
      if (Date.now() - st.startedAt >= this.stableMs) st.delay = this.minDelayMs;
      const wait = st.delay; st.delay = Math.min(st.delay * 2, this.maxDelayMs); st.restarts++;
      this.emit("restarting", { name, inMs: wait, restarts: st.restarts });
      st.timer = setTimeout(() => { st.timer = null; if (!this.stopping) this.#launch(name); }, wait);
    };
    child.on("exit", onGone); child.on("error", (e) => onGone(null, e.code || "spawn-error"));
  }

  status() { return [...this.state.entries()].map(([name, s]) => ({ name, pid: s.child ? s.child.pid : null, running: !!s.child, restarts: s.restarts })); }

  /** Stops everything, last started first; anything still alive after killAfterMs is killed. */
  async stop() {
    this.stopping = true;
    const waits = [];
    for (const st of [...this.state.values()].reverse()) {
      clearTimeout(st.timer); const c = st.child; if (!c) continue;
      const pid = c.pid;
      waits.push(new Promise((res) => { const k = setTimeout(() => signal(pid, "SIGKILL"), this.killAfterMs); c.once("exit", () => { clearTimeout(k); setTimeout(() => { signal(pid, "SIGKILL"); res(); }, 100); }); }));
      signal(pid, "SIGTERM");
    }
    await Promise.all(waits);
  }
}

/** Signal a service's whole process group (falls back to the process itself). */
function signal(pid, sig) {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}
