#!/usr/bin/env node
// Records the demo with the real harnesses: the glasses (simulator) on the left; on the right, the app each command
// reaches. Claude Code and Codex are their own terminal interfaces (resumed in a pseudo-terminal), Cowork and
// ChatGPT their web pages in one narrow Chrome window captured on its own, cross-harness scenes the Command Center
// page. Needs: the normal stack with presentation mode on, `npm run sim`, and `node tools/demo/prepare-real.mjs`.
//   node tools/demo/record-real.mjs [out.mp4]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import ffmpeg from "ffmpeg-static";
import { REPO_ROOT, RUN_DIR } from "@command-center/core/paths.mjs";
import { openTerminal } from "./term.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(process.argv[2] || path.join(HERE, "out", "command-center-real.mp4"));
const SIM = "http://127.0.0.1:9898", GATEWAY = "http://127.0.0.1:3000";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CLAUDE = path.join(process.env.HOME, ".local/bin/claude"), CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const DEMO = "/Users/Shared/Demo/acme-api", WIN = { left: 40, top: 40, width: 560, height: 980 };
const token = fs.readFileSync(path.join(RUN_DIR, "token"), "utf8").trim();
const ids = JSON.parse(fs.readFileSync(path.join(RUN_DIR, "demo-real.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const node = (script, ...a) => execFileSync(process.execPath, [path.join(REPO_ROOT, script), ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
const ctl = (...a) => { const out = node("apps/agentd/src/agentctl.mjs", ...a, "--json").trim(); return out && out !== "undefined" ? JSON.parse(out) : null; };
const bridge = (...a) => node("extension/cli/bridge.mjs", ...a);
const native = (sid) => sid.slice(sid.indexOf(":") + 1);
const webUrl = (sid) => sid.startsWith("chatgpt:") ? `https://chatgpt.com/c/${native(sid)}` : sid.startsWith("cowork:chat:") ? `https://claude.ai/chat/${sid.slice(12)}` : `https://claude.ai/cowork/${native(sid)}`;

async function say(text) {
  const r = await fetch(`${GATEWAY}/api/glasses/voice`, { method: "POST", headers: { "X-CC-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const n = (await r.json()).glasses;
  if (!n) throw new Error("no glasses connected: start the simulator (npm run sim)");
  if (n > 1) throw new Error("more than one glasses connection (is the Even app open on the phone?): commands would run twice");
}
async function glassesPng() { const r = await fetch(`${SIM}/api/screenshot/glasses`); return `data:image/png;base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`; }
async function until(fn, ms = 120000, every = 1500) { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting"); await sleep(every); } }
const newSession = async (provider, before) => until(async () => ctl("sessions", "--provider", provider).sessions.find((s) => !before.has(s.sessionId) && !s.masked));

// ---------- right-hand panels ----------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ui = await browser.newPage({ viewport: { width: 900, height: 980 }, colorScheme: "dark" });
await ui.goto(GATEWAY + "/");
await ui.addStyleTag({ content: ".newtask { display: none !important; } ::-webkit-scrollbar { display: none; }" });
let term = null, winId = null;
const panels = {
  web: { label: "On the computer · <b>Command Center</b>", fit: false, shot: async () => `data:image/jpeg;base64,${(await ui.screenshot({ type: "jpeg", quality: 88 })).toString("base64")}` },
  term: (name) => ({ label: `On the computer · <b>${name}</b>`, fit: true, note: `${name}'s own terminal interface, opened on the session`, shot: async () => `data:image/jpeg;base64,${(await term.screenshot()).toString("base64")}` }),
  window: (name) => ({ label: `On the computer · <b>${name}</b>`, fit: true, note: `${name} in Chrome, showing only this session`, shot: async () => {
    const f = path.join(frames, "win.jpg"); execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-t", "jpg", "-l", String(winId), f]);
    return `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}`;
  } }),
};
// Open the new terminal before closing the old one: frames are still being captured from the old one meanwhile.
async function openTerm(name, cmd, args, o = {}) {
  const next = await openTerminal(browser, { cmd, args, cwd: DEMO, cols: 78, rows: 36, fontSize: 16, ...o }); await sleep(4500); await next.ready();
  const old = term; term = next; if (old) setTimeout(() => old.close().catch(() => {}), 1500);
  return panels.term(name);
}
async function openWindow(name, url) {
  bridge("demo-window", url);
  winId = await until(async () => { const w = JSON.parse(execFileSync(path.join(HERE, "bin/windows"), { encoding: "utf8" })).find((x) => x.app === "Google Chrome" && Math.abs(x.w - WIN.width) < 4 && Math.abs(x.h - WIN.height) < 4); return w && w.id; }, 15000, 500);
  await sleep(3500); return panels.window(name);
}

// ---------- capture ----------
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const frames = fs.mkdtempSync(path.join(path.dirname(OUT), ".frames-"));
const studio = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
await studio.goto("file://" + path.join(HERE, "studio.html"));
const shots = [], scenes = []; const t0 = Date.now(); let panel = panels.web;
async function frame(meta) {
  const [g, c] = meta.title ? [null, null] : await Promise.all([glassesPng(), panel.shot()]);
  await studio.evaluate((m) => window.setFrame(m), { ...meta, glasses: g, computer: c, panel: meta.title ? undefined : { label: panel.label, fit: panel.fit, note: panel.note } });
  const f = path.join(frames, `f${String(shots.length).padStart(5, "0")}.jpg`); await studio.screenshot({ path: f, type: "jpeg", quality: 92 }); shots.push([f, Date.now()]);
}
async function hold(ms, meta) { const end = Date.now() + ms; do { await frame(meta); } while (Date.now() < end); }
let n = 0; const TOTAL = 15;
async function scene({ say: text, what, ms = 5000, clip, before, after, title }) {
  scenes.push({ at: (Date.now() - t0) / 1000, say: text || null, what: what || (title && title.p) || "", clip: clip || null });
  if (title) { await frame({ title }); await sleep(ms); return; }
  if (before) panel = (await before()) || panel;
  if (text) { n++; await say(text); }
  const meta = { say: text, what, step: text ? `${n} / ${TOTAL}` : "" };
  if (after) {   // keep filming while waiting for the real app (a new task, a finished turn), then switch to it
    await hold(1500, meta);
    let done = false, result, error; after(meta).then((r) => { result = r; done = true; }, (e) => { error = e; done = true; });
    while (!done) await frame(meta);
    if (error) throw error;
    panel = result || panel;
  }
  await hold(ms, meta);
}

// The simulator listens through this computer's microphone: never record in free talk. Restore it afterwards.
const prefsFile = path.join(RUN_DIR, "g2-prefs.json");
// Switch it off through the gateway BEFORE starting the simulator (it listens from the moment it connects), and
// back on only after the simulator has stopped:  curl -X POST .../api/glasses/free-talk -d '{"on":false}'
if (JSON.parse(fs.readFileSync(prefsFile, "utf8")).free) throw new Error("free talk is on: switch it off before starting the simulator (POST /api/glasses/free-talk {on:false})");

try {
  await scene({ title: { h: 'Your AI agents,<br>on your glasses<span class="dot">.</span>', p: "Claude Code, Codex, Cowork and ChatGPT, run from Even Realities G2 by voice. Everything runs on your own Mac." }, ms: 4500 });
  await scene({ clip: "1-whats-running", what: "Home: what needs you, what's running, the latest sessions. Everything not in this demo is masked.", ms: 5000, before: () => panels.web });
  await scene({ clip: "1-whats-running", say: "What's running?", what: "Everything working right now, across all four harnesses.", ms: 6000 });
  await scene({ clip: "2-cowork", say: "Open Cowork", what: "One harness at a time.", ms: 5500, before: () => openWindow("Cowork", webUrl(ids.cowork)) });
  await scene({ clip: "2-cowork", say: "Open Acme Q3 board deck", what: "Open a Cowork task by name. It opens where you left off.", ms: 5500 });
  await scene({ clip: "2-cowork", say: "Add a slide on customer churn, one line, and reply with the full outline", what: "Talk to the task: your words go straight into Cowork.", ms: 4500 });
  await scene({ clip: "2-cowork", say: "Send it", what: "Sent to Cowork on the Mac; the task picks it up right away.", ms: 16000 });
  await scene({ clip: "3-codex-approval", say: "What needs me?", what: "One list of everything waiting on you.", ms: 5500, before: () => panels.web });
  await scene({ clip: "3-codex-approval", say: "Next", what: "Codex wants to run the migration dry run.", ms: 5500 });
  await scene({ clip: "3-codex-approval", say: "Approve", what: "Approvals need the word “approve”. A stray “yes” never runs anything.", ms: 4000 });
  await scene({ clip: "3-codex-approval", say: "Approve", what: "Approved from the glasses: Codex runs it on the Mac.", ms: 9000,
    after: async () => {
      // the approval on camera runs the dry run; Codex's follow-up steps (it asks before every command in this demo)
      // are approved here, off camera, until it reports back
      await until(async () => {
        const req = (ctl("attention") || []).find((x) => x.sessionId === ids.codex && x.kind === "approval");
        if (req) { ctl("approve", req.requestId, "--takeover"); ctl("release", ids.codex); return false; }   // the glasses hold the lease after approving
        return ctl("status", ids.codex).status === "complete";
      }, 180000, 2000);
      ctl("close", ids.codex); await sleep(3000);   // let the session service let go of the thread first
      return openTerm("Codex", CODEX, ["resume", native(ids.codex)], { cropBottom: 4 });   // its footer says the thread is read-only here
    } });
  await scene({ clip: "4-claude-code", say: "Open refactor auth middleware", what: "Open any session by name, where you left off.", ms: 6000, before: () => openTerm("Claude Code", CLAUDE, ["--resume", native(ids.claudeCode)]) });
  await scene({ clip: "4-claude-code", say: "Summarize what you changed in two lines", what: "Talk to the agent: your words go straight into the session.", ms: 4500 });
  await scene({ clip: "4-claude-code", say: "Send it", what: "Claude Code answers; here it is in Claude Code itself.", ms: 9000,
    after: async () => { await until(async () => ["complete", "idle"].includes(ctl("status", ids.claudeCode).status) && ctl("get", ids.claudeCode, "1").messages.at(-1).role === "assistant", 120000); return openTerm("Claude Code", CLAUDE, ["--resume", native(ids.claudeCode)]); } });
  await scene({ clip: "5-chatgpt", say: "Home", what: "", ms: 3000, before: () => panels.web });
  await scene({ clip: "5-chatgpt", say: "Open Lisbon trip plan", what: "ChatGPT too: open a chat by name.", ms: 5000, before: () => openWindow("ChatGPT", webUrl(ids.chatgpt)) });
  await scene({ clip: "5-chatgpt", say: "What should I pack for late October?", what: "Ask a follow-up from the glasses.", ms: 4500 });
  await scene({ clip: "5-chatgpt", say: "Send it", what: "Asked in ChatGPT on the Mac; the answer comes back to the glasses.", ms: 16000 });
  await scene({ title: { h: 'Built for walking around<span class="dot">.</span>', p: "Voice first, glanceable screens, push to talk or hands-free, big text while walking. Open source: github.com/lmarquina/command-center" }, ms: 5000 });
  shots.push([shots.at(-1)[0], Date.now()]);
  const list = shots.slice(0, -1).map(([f, t], i) => `file '${f}'\nduration ${((shots[i + 1][1] - t) / 1000).toFixed(3)}`).join("\n") + `\nfile '${shots.at(-1)[0]}'\n`;
  fs.writeFileSync(path.join(frames, "list.txt"), list);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(frames, "list.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", OUT]);
  fs.writeFileSync(OUT.replace(/\.mp4$/, ".scenes.json"), JSON.stringify(scenes.map((x) => ({ ...x, at: Math.round(x.at * 10) / 10 })), null, 1));
  for (const name of [...new Set(scenes.map((x) => x.clip).filter(Boolean))]) {
    const i0 = scenes.findIndex((x) => x.clip === name), i1 = scenes.findLastIndex((x) => x.clip === name);
    const from = Math.max(0, scenes[i0].at - 0.3), to = i1 + 1 < scenes.length ? scenes[i1 + 1].at : null;
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", String(from), ...(to ? ["-to", String(to)] : []), "-i", OUT, "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", OUT.replace(/\.mp4$/, `-${name}.mp4`)]);
  }
  console.log(`wrote ${OUT} (${shots.length} frames, ${((shots.at(-1)[1] - shots[0][1]) / 1000).toFixed(0)} s)`);
} finally {
  if (term) await term.close();
  try { bridge("demo-close"); } catch {}
  await browser.close();
  fs.rmSync(frames, { recursive: true, force: true });
}
