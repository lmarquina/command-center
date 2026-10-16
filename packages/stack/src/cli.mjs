#!/usr/bin/env node
// Starts and stops the whole Command Center on this computer.
//   up [--foreground]   start every service in config stack.services (in the background unless --foreground)
//   down                stop them      status   what is running      sim   desktop glasses simulator
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { loadConfig } from "@command-center/core/config.mjs";
import { REPO_ROOT, RUN_DIR, runPath } from "@command-center/core/paths.mjs";
import { Supervisor } from "./supervisor.mjs";
import { serviceSpecs, simSpecs } from "./services.mjs";

const PID = runPath("stack.pid"), STATE = runPath("stack.json"), LOGS = path.join(RUN_DIR, "logs");
const [cmd = "status", ...flags] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const runningPid = () => { try { const p = Number(fs.readFileSync(PID, "utf8")); return p && alive(p) ? p : null; } catch { return null; } };
const socketUp = (p) => new Promise((r) => { const c = net.createConnection(p); c.on("connect", () => { c.end(); r(true); }); c.on("error", () => r(false)); });
const stamp = () => new Date().toISOString();

async function supervise(specs, { record }) {
  const sup = new Supervisor({ services: specs, logDir: LOGS });
  const save = () => { if (record) fs.writeFileSync(STATE, JSON.stringify({ pid: process.pid, at: stamp(), services: sup.status() }, null, 1), { mode: 0o600 }); };
  sup.on("started", (e) => { console.log(`${stamp()} started ${e.name} (pid ${e.pid})`); save(); });
  sup.on("exited", (e) => { console.log(`${stamp()} ${e.name} exited (${e.signal || e.code})`); save(); });
  sup.on("restarting", (e) => console.log(`${stamp()} restarting ${e.name} in ${e.inMs} ms (restart #${e.restarts})`));
  const end = async (why) => { console.log(`${stamp()} stopping: ${why}`); await sup.stop(); if (record) { for (const f of [PID, STATE]) try { fs.unlinkSync(f); } catch {} } process.exit(0); };
  process.on("SIGTERM", () => end("SIGTERM")); process.on("SIGINT", () => end("SIGINT"));
  sup.start();
}

// Start at login: a per-user LaunchAgent that runs the supervisor in the foreground and always restarts it.
// While it is installed, launchd owns the lifecycle: `npm run dev` loads it, `npm run stop` unloads it (so a stop
// stays stopped until the next login or the next `npm run dev`).
const AGENT = "com.commandcenter.stack";
export function launchAgentPlist({ node, cli, root, logs, path: PATH }) {
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(cli)}</string><string>up</string><string>--foreground</string></array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(PATH)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(path.join(logs, "stack.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logs, "stack.log"))}</string>
</dict></plist>
`;
}

// If the previous supervisor died without stopping its services (crash, kill -9), they are still running in their
// own process groups and would collide with the new ones (ports, the daemon socket). Stop them first.
function reapOrphans() {
  let prev; try { prev = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return; }
  if (!prev || alive(prev.pid)) return;
  for (const s of prev.services || []) if (s.pid && alive(s.pid)) { console.log(`${stamp()} stopping ${s.name} (pid ${s.pid}) left by a supervisor that died`); try { process.kill(-s.pid, "SIGTERM"); } catch { try { process.kill(s.pid, "SIGTERM"); } catch {} } }
  const t0 = Date.now(); while (Date.now() - t0 < 3000 && (prev.services || []).some((s) => s.pid && alive(s.pid))) { const w = Date.now(); while (Date.now() - w < 100); }
  for (const s of prev.services || []) if (s.pid && alive(s.pid)) { try { process.kill(-s.pid, "SIGKILL"); } catch {} }
}

const AGENT_PLIST = path.join(process.env.HOME || "", "Library/LaunchAgents", `${AGENT}.plist`);
async function launchctl(...a) { const { execFileSync } = await import("node:child_process"); try { execFileSync("/bin/launchctl", a, { stdio: "ignore" }); return true; } catch { return false; } }
const loginItemInstalled = () => fs.existsSync(AGENT_PLIST);

const COMMANDS = {
  async up() {
    if (runningPid()) { console.log(`already running (pid ${runningPid()}). Stop with: npm run stop`); return; }
    const config = loadConfig();
    if (flags.includes("--foreground")) { reapOrphans(); fs.writeFileSync(PID, String(process.pid), { mode: 0o600 }); return supervise(serviceSpecs({ config, root: REPO_ROOT }), { record: true }); }
    fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
    if (loginItemInstalled()) {   // launchd runs (and keeps restarting) the supervisor
      const uid = process.getuid();
      // bootstrap alone may not start it (RunAtLoad applies at login), so always kickstart as well
      if (!(await launchctl("kickstart", `gui/${uid}/${AGENT}`))) { await launchctl("bootstrap", `gui/${uid}`, AGENT_PLIST); await launchctl("kickstart", `gui/${uid}/${AGENT}`); }
    } else {
      const out = fs.openSync(path.join(LOGS, "stack.log"), "a", 0o600);
      const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "up", "--foreground"], { detached: true, stdio: ["ignore", out, out], cwd: REPO_ROOT });
      child.unref();
    }
    const wantsDaemon = config.stack.services.includes("agentd");
    for (let i = 0; i < 60 && !(runningPid() && (!wantsDaemon || (await socketUp(path.join(RUN_DIR, "agentd.sock"))))); i++) await sleep(500);
    await COMMANDS.status();
    const g = config.gateway;
    console.log(`\nWeb UI:   http://127.0.0.1:${g.port}\nLogs:     ${LOGS}\nPair the glasses:  npm run qr -w @command-center/glasses\nStop:     npm run stop`);
  },
  async down() {
    const pid = runningPid();
    if (loginItemInstalled()) await launchctl("bootout", `gui/${process.getuid()}/${AGENT}`);   // unload, so launchd doesn't restart it
    if (!pid) { console.log("not running"); return; }
    try { process.kill(pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
    console.log(alive(pid) ? `still stopping (pid ${pid}); check ${LOGS}/stack.log` : "stopped");
  },
  async status() {
    const pid = runningPid();
    if (!pid) { console.log("Command Center is not running. Start with: npm run dev"); return; }
    let s = { services: [] }; try { s = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch {}
    console.log(`Command Center is running (supervisor pid ${pid})`);
    for (const x of s.services) console.log(`  ${x.running ? "up  " : "DOWN"} ${x.name.padEnd(9)}${x.pid ? ` pid ${x.pid}` : ""}${x.restarts ? `  restarted ${x.restarts}x` : ""}`);
  },
  async "login-item"() {
    const sub = flags[0], plist = AGENT_PLIST, uid = process.getuid(), lc = launchctl;
    if (sub === "install") {
      fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
      const PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");   // uv lives in Homebrew
      fs.writeFileSync(plist, launchAgentPlist({ node: process.execPath, cli: new URL(import.meta.url).pathname, root: REPO_ROOT, logs: LOGS, path: PATH }));
      if (runningPid()) await COMMANDS.down();   // hand a running stack over to launchd
      await lc("bootout", `gui/${uid}/${AGENT}`); await lc("bootstrap", `gui/${uid}`, plist); await lc("kickstart", `gui/${uid}/${AGENT}`);
      console.log(`installed: ${plist}\nCommand Center now starts when you log in. Remove with: npm run login-item -- remove`);
    } else if (sub === "remove") {
      await lc("bootout", `gui/${uid}/${AGENT}`); try { fs.unlinkSync(plist); } catch {}
      console.log("removed: Command Center no longer starts at login, and was stopped. Start it with: npm run dev");
    } else console.log(fs.existsSync(plist) ? `installed (${plist})` : "not installed. Install with: npm run login-item -- install");
  },
  async sim() {
    const tokenFile = path.join(RUN_DIR, "token");
    if (!runningPid() || !fs.existsSync(tokenFile)) { console.error("Start the stack first: npm run dev"); process.exit(1); }
    const config = loadConfig();
    console.log(`Simulator starting. Screenshot/automation API on http://127.0.0.1:${config.stack.simAutomationPort} (Ctrl-C to stop)`);
    return supervise(simSpecs({ config, root: REPO_ROOT, token: fs.readFileSync(tokenFile, "utf8").trim() }), { record: false });
  },
};
if (!COMMANDS[cmd]) { console.error("usage: stack up [--foreground] | down | status | sim | login-item [install|remove]"); process.exit(2); }
if (process.argv[1] && process.argv[1].endsWith("cli.mjs")) await COMMANDS[cmd]();
