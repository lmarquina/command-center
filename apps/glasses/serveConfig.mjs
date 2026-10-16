// Where and how the glasses app is served, derived from the shared config and the optional certificate in run/tls.
// With a certificate (from `tailscale cert`): https at that name on all interfaces, so the phone can load the app
// over cellular. plain=true: http on 127.0.0.1 at appPort+1, for the desktop simulator only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function serveConfig({ config, tlsDir, plain = false }) {
  const g = config.gateway.glasses, crt = path.join(tlsDir, "ts.crt"), key = path.join(tlsDir, "ts.key");
  const has = !plain && fs.existsSync(crt) && fs.existsSync(key);
  const cert = has ? fs.readFileSync(crt) : null;
  const host = has ? new crypto.X509Certificate(cert).subject.replace(/^.*CN=/s, "").trim() : null;
  return {
    host, scheme: has ? "https" : "http", port: plain ? g.appPort + 1 : g.appPort, glassesPort: g.port,
    server: {
      host: plain ? "127.0.0.1" : "0.0.0.0", port: plain ? g.appPort + 1 : g.appPort, strictPort: true,
      ...(has ? { https: { cert, key: fs.readFileSync(key) }, allowedHosts: [host], hmr: { host, protocol: "wss" } } : {}),
    },
  };
}
