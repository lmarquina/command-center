#!/usr/bin/env node
// Records the product demo: the glasses (from the simulator's screenshot API) next to the computer (the Command
// Center web page), with a caption for each spoken command. Commands are typed into the same path as speech
// (POST /api/glasses/voice), so the run is repeatable. Needs a demo stack and the simulator:
//   CC_DEMO=1 CC_RUN_DIR=$PWD/run-demo node packages/stack/src/cli.mjs up --foreground &
//   CC_RUN_DIR=$PWD/run-demo npm run sim &
//   CC_RUN_DIR=$PWD/run-demo node tools/demo/record.mjs [out.mp4]
// Output: an H.264 1080p video at 30 fps (no audio: the voice-over is added afterwards).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import ffmpeg from "ffmpeg-static";
import { RUN_DIR } from "@command-center/core/paths.mjs";
import { SCRIPT } from "./script.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(process.argv[2] || path.join(HERE, "out", "command-center-demo.mp4"));
const SIM = "http://127.0.0.1:9898", GATEWAY = "http://127.0.0.1:3000";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const token = fs.readFileSync(path.join(RUN_DIR, "token"), "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function say(text) {
  const r = await fetch(`${GATEWAY}/api/glasses/voice`, { method: "POST", headers: { "X-CC-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const j = await r.json(); if (!j.glasses) throw new Error("no glasses connected: start the simulator first (npm run sim)");
}
async function glassesPng() { const r = await fetch(`${SIM}/api/screenshot/glasses`); if (!r.ok) throw new Error(`simulator screenshot: HTTP ${r.status}`); return `data:image/png;base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`; }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const frames = fs.mkdtempSync(path.join(path.dirname(OUT), ".frames-"));
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ui = await browser.newPage({ viewport: { width: 900, height: 980 }, colorScheme: "dark" });
  await ui.goto(GATEWAY + "/");
  await ui.addStyleTag({ content: ".newtask { display: none !important; } ::-webkit-scrollbar { display: none; }" });   // show the sessions, not the form
  const studio = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  await studio.goto("file://" + path.join(HERE, "studio.html"));

  const shots = [];   // [file, timestamp]
  async function frame(meta) {
    const [g, c] = await Promise.all([meta.title ? null : glassesPng(), meta.title ? null : ui.screenshot({ type: "jpeg", quality: 88 }).then((b) => `data:image/jpeg;base64,${b.toString("base64")}`)]);
    await studio.evaluate((m) => window.setFrame(m), { ...meta, glasses: g, computer: c });
    const f = path.join(frames, `f${String(shots.length).padStart(5, "0")}.jpg`);
    await studio.screenshot({ path: f, type: "jpeg", quality: 92 });
    shots.push([f, Date.now()]);
  }
  async function hold(ms, meta) { const end = Date.now() + ms; do { await frame(meta); } while (Date.now() < end); }

  const spoken = SCRIPT.filter((s) => s.say).length; let k = 0;
  for (const s of SCRIPT) {
    if (s.title) { await frame({ title: s.title }); await sleep(s.ms); continue; }
    if (s.say) { k++; await say(s.say); }
    await hold(s.ms, { say: s.say, what: s.what, step: s.say ? `${k} / ${spoken}` : "" });
  }
  shots.push([shots[shots.length - 1][0], Date.now()]);

  // Each captured frame lasts until the next one was taken: real timing, then resampled to a steady 30 fps.
  const list = shots.slice(0, -1).map(([f, t], i) => `file '${f}'\nduration ${((shots[i + 1][1] - t) / 1000).toFixed(3)}`).join("\n") + `\nfile '${shots[shots.length - 1][0]}'\n`;
  fs.writeFileSync(path.join(frames, "list.txt"), list);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(frames, "list.txt"), "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", OUT]);
  console.log(`wrote ${OUT} (${shots.length} frames, ${((shots[shots.length - 1][1] - shots[0][1]) / 1000).toFixed(0)} s)`);
} finally {
  await browser.close();
  fs.rmSync(frames, { recursive: true, force: true });
}
