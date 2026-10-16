// How the phone reaches the glasses gateway: allowed origins and the optional TLS certificate. No side effects.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUN_DIR } from "@command-center/core/paths.mjs";

// Who may open the glasses WebSocket: the glasses app's dev server on localhost (simulator), on this computer's LAN
// address (phone on the same Wi-Fi), and on its Tailscale name when a certificate is present.
export function lanIp() { for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) if (i.family === "IPv4" && !i.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(i.address)) return i.address; return null; }
// A certificate in run/tls (from `tailscale cert`) switches the glasses endpoint to wss:// and the app to https://,
// which is what lets the phone connect over cellular. Without it: plain ws:// on the local network.
export function loadTls(dir = path.join(RUN_DIR, "tls")) {
  const crt = path.join(dir, "ts.crt"), key = path.join(dir, "ts.key");
  if (!fs.existsSync(crt) || !fs.existsSync(key)) return null;
  const cert = fs.readFileSync(crt);
  return { cert, key: fs.readFileSync(key), host: new crypto.X509Certificate(cert).subject.replace(/^.*CN=/s, "").trim() };
}
export function glassesOrigins(g, tls, ip = lanIp()) {
  if (g.origins) return g.origins;
  const a = g.appPort;
  return [`http://localhost:${a}`, `http://127.0.0.1:${a}`, ...(ip && g.allowPlainLan ? [`http://${ip}:${a}`] : []), ...(tls ? [`https://${tls.host}:${a}`] : [])];
}
