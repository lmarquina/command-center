// A long-lived connection to a local Unix socket that comes back after the other side restarts.
// A failed socket emits both "error" and "close"; reconnecting on each doubles the attempts every round while the
// other side is down, until the process runs out of memory. This reconnects exactly once per lost socket.
import net from "node:net";

/**
 * @param {object} o
 * @param {string} o.path            socket path
 * @param {(sock: net.Socket) => void} [o.onConnect]
 * @param {(msg: object) => void} o.onMessage   one parsed JSON object per newline-delimited line
 * @param {() => void} [o.onDown]    called once per lost connection (not for failed attempts while already down)
 * @param {number} [o.retryMs]
 * @returns {{ close(): void, readonly connected: boolean }}
 */
export function keepConnected({ path, onConnect = () => {}, onMessage, onDown = () => {}, retryMs = 1500 }) {
  let closed = false, connected = false, sock = null, timer = null;
  const open = () => {
    const s = net.createConnection(path); sock = s; let buf = "", done = false;
    s.on("connect", () => { connected = true; onConnect(s); });
    s.on("data", (d) => {
      buf += d; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        onMessage(m);
      }
    });
    const lost = () => {
      if (done) return; done = true;
      if (connected) { connected = false; onDown(); }
      if (!closed) timer = setTimeout(open, retryMs);
    };
    s.on("error", lost); s.on("close", lost);
  };
  open();
  return { close() { closed = true; clearTimeout(timer); if (sock) sock.destroy(); }, get connected() { return connected; } };
}
