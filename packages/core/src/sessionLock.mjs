// Single-writer lock per session, shared by every adapter process on this machine.
// File: <lockDir>/<sessionId>.lock, created with O_EXCL; contains {sessionId, owner, pid, acquiredAt}.
// A lock whose pid is no longer alive is stale and may be taken over (crash recovery).
import fs from "node:fs";
import path from "node:path";

export class SessionLock {
  constructor(lockDir, owner) {
    this.dir = lockDir; this.owner = owner;
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  }
  file(sessionId) {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw Object.assign(new Error(`bad session id ${sessionId}`), { code: "BAD_SESSION_ID" });
    return path.join(this.dir, `${sessionId}.lock`);
  }
  read(sessionId) { try { return JSON.parse(fs.readFileSync(this.file(sessionId), "utf8")); } catch { return null; } }
  static alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }

  acquire(sessionId) {
    const f = this.file(sessionId);
    const rec = { sessionId, owner: this.owner, pid: process.pid, acquiredAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(f, "wx", 0o600);
        fs.writeSync(fd, JSON.stringify(rec)); fs.closeSync(fd);
        return rec;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        const cur = this.read(sessionId);
        if (cur && cur.pid === process.pid && cur.owner === this.owner) return cur; // re-entrant
        if (cur && SessionLock.alive(cur.pid)) throw Object.assign(new Error(`session ${sessionId} is locked by ${cur.owner} (pid ${cur.pid}) since ${cur.acquiredAt}`), { code: "SESSION_LOCKED", holder: cur });
        try { fs.unlinkSync(f); } catch {} // stale: holder died
      }
    }
    throw Object.assign(new Error(`could not acquire lock for ${sessionId}`), { code: "SESSION_LOCKED" });
  }
  release(sessionId) {
    const cur = this.read(sessionId);
    if (cur && cur.pid === process.pid && cur.owner === this.owner) { try { fs.unlinkSync(this.file(sessionId)); } catch {} }
  }
}
