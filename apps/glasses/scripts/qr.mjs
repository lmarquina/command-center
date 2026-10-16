#!/usr/bin/env node
// Shows the pairing QR for the Even app (Even Hub tab → Scan QR). The QR carries the gateway token in the URL
// fragment, so it is only ever drawn in this terminal: the URL itself is never printed or logged.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@command-center/core/config.mjs";
import { RUN_DIR } from "@command-center/core/paths.mjs";
import { serveConfig } from "../serveConfig.mjs";

const tokenFile = path.join(RUN_DIR, "token");
if (!fs.existsSync(tokenFile)) { console.error("No gateway token yet. Start the gateway once first: npm run gateway"); process.exit(1); }
const s = serveConfig({ config: loadConfig(), tlsDir: path.join(RUN_DIR, "tls") });
const lan = () => { for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) if (i.family === "IPv4" && !i.internal) return i.address; return "127.0.0.1"; };
const host = s.host || lan();
console.error(`Pairing with ${s.scheme}://${host}:${s.port} ${s.host ? "(works over cellular via Tailscale)" : "(same Wi-Fi only: no certificate in run/tls)"}`);
const cli = new URL("../../../node_modules/@evenrealities/evenhub-cli/main.js", import.meta.url).pathname;
// The Even CLI echoes the URL it encodes; drop any output line that carries the token.
const child = spawn(process.execPath, [cli, "qr", "--url", `${s.scheme}://${host}:${s.port}/#t=${fs.readFileSync(tokenFile, "utf8").trim()}`, "-e"], { stdio: ["ignore", "pipe", "pipe"] });
const filter = (out) => { let buf = ""; return (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.includes("#t=")) out.write(line + "\n"); } }; };
child.stdout.on("data", filter(process.stdout)); child.stderr.on("data", filter(process.stderr));
child.on("exit", (c) => { console.error("The QR is open in a window on this screen."); process.exit(c ?? 0); });
