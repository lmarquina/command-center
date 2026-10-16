#!/usr/bin/env node
// Prepares the "real harnesses" demo: real demo sessions in each harness, all about the made-up project in
// ~/Demo/acme-api, with presentation mode on so every other session is masked. Re-run before each take: it makes a
// fresh Codex thread that stops at an approval (the one approved on camera). Ids go to run/demo-real.json.
//   node tools/demo/prepare-real.mjs [--cowork]   (--cowork also seeds a Cowork task through Claude Desktop)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, RUN_DIR } from "@command-center/core/paths.mjs";

const DEMO = "/Users/Shared/Demo/acme-api", STATE = path.join(RUN_DIR, "demo-real.json");
const ctl = (...a) => { const out = execFileSync(process.execPath, [path.join(REPO_ROOT, "apps/agentd/src/agentctl.mjs"), ...a, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 }).trim(); return out && out !== "undefined" ? JSON.parse(out) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 });

// A clean project for every take (the demo folder only ever holds this made-up repo).
execFileSync("git", ["checkout", "-q", "--", "."], { cwd: DEMO }); execFileSync("git", ["clean", "-qfd"], { cwd: DEMO });

// Approve the steps an agent asks for in the demo folder, off camera, until it is done (or `stopAt` is pending).
async function runToEnd(sid, stopAt) {
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const req = (ctl("attention") || []).find((a) => a.sessionId === sid && a.kind === "approval");
    if (req && stopAt && stopAt(req.text)) { console.log(`${sid}: waiting on "${req.text}"`); ctl("release", sid); return; }
    if (req) { ctl("approve", req.requestId, "--takeover"); console.log(`approved: ${req.text.slice(0, 80)}`); continue; }
    if (!stopAt && ["complete", "idle"].includes((ctl("status", sid) || {}).status)) { ctl("release", sid); return; }
  }
  throw new Error(`${sid} did not get there in time`);
}

// Claude Code: a fresh session that has just done the refactor (so the on-camera question is its first follow-up).
const cc = ctl("create", "claude-code", DEMO, "Refactor auth middleware").sessionId;
state.claudeCode = cc; save();
execFileSync(process.execPath, [path.join(REPO_ROOT, "apps/agentd/src/agentctl.mjs"), "send", cc, "Split src/middleware/auth.js into two functions: parseToken() that only validates and decodes the bearer token, and loadSession() that looks up the session. Keep auth() as the public entry point and keep all tests passing. Keep the change small.", "--detach"], { stdio: "ignore" });
await runToEnd(cc);
console.log(`claude code ${cc}: refactor done`);

// Codex: a fresh thread each take, stopped at the dry-run approval.
const cx = ctl("create", "codex", DEMO, "Migrate API to v2 endpoints").sessionId;
state.codex = cx; save();
execFileSync(process.execPath, [path.join(REPO_ROOT, "apps/agentd/src/agentctl.mjs"), "send", cx, "Plan the move of the client calls in src/client from /api/v1 to /api/v2 with the migration script: run npm run migrate -- --dry-run and report what it would change. Do not apply it yet.", "--detach"], { stdio: "ignore" });
await runToEnd(cx, (text) => /npm run migrate|node scripts\/migrate\.mjs/.test(text));   // any request that runs the migration

// ChatGPT: one existing chat for the list (created once).
if (!state.chatgpt) { state.chatgpt = ctl("create", "chatgpt", "-", "Plan a three-day Lisbon trip for late October that avoids the biggest tourist crowds. Short bullets per day.").sessionId; save(); }

// Cowork: one existing task (through Claude Desktop, so it moves windows on the screen: only with --cowork).
if (process.argv.includes("--cowork") && !state.cowork) {
  state.cowork = ctl("create", "cowork", "-", "Outline the Q3 board deck for Acme: revenue, hiring and product milestones, six slides with one line each. Reply in the chat, no files.").sessionId; save();
}
console.log(JSON.stringify(state, null, 1));
