#!/usr/bin/env node
// Publishes a clean copy of this (private) repo's main branch to the public repo. One-way: nothing comes back.
//   npm run publish             dry run: export, scan, and show what would change
//   npm run publish -- --push   do it (one commit on the public repo)
//   npm run publish -- --push --create   first time only: create the public repo
// Settings in config/local.json → "publish": { "repo": "owner/name", "terms": [...personal words...], "exclude": [...paths] }
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "@command-center/core/config.mjs";
import { REPO_ROOT, RUN_DIR } from "@command-center/core/paths.mjs";
import { findLeaks, rulesFor } from "./scan.mjs";

const args = process.argv.slice(2), push = args.includes("--push"), create = args.includes("--create");
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o }).trim();
const git = (a, cwd = REPO_ROOT) => sh("git", a, { cwd });
const fail = (msg) => { console.error(`publish: ${msg}`); process.exit(1); };

const cfg = loadConfig().publish || {};
if (!cfg.repo) fail('set "publish": { "repo": "owner/name", "terms": [...] } in config/local.json');
if (!Array.isArray(cfg.terms) || !cfg.terms.length) fail("publish.terms is empty: list the personal words to block (client names, hostnames, ids)");

// 1. Source: exactly what is committed on main (never the working tree, never gitignored files).
if (git(["status", "--porcelain"])) fail("working tree has uncommitted changes; commit or stash first");
git(["fetch", "-q", "origin", "main"]);
const sha = git(["rev-parse", "origin/main"]), short = sha.slice(0, 7);
const work = path.join(RUN_DIR, "publish"), out = path.join(work, "export"), clone = path.join(work, "public");
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
execFileSync("/bin/sh", ["-c", `git archive ${sha} | tar -x -C "${out}"`], { cwd: REPO_ROOT });
for (const ex of cfg.exclude || []) fs.rmSync(path.join(out, ex), { recursive: true, force: true });
// Excluded workspaces must also leave the workspace list and the lockfile, or a fresh clone can't install.
if (cfg.exclude && cfg.exclude.length) {
  const pj = path.join(out, "package.json"), root = JSON.parse(fs.readFileSync(pj, "utf8"));
  root.workspaces = root.workspaces.filter((w) => w.includes("*") || fs.existsSync(path.join(out, w)));
  for (const [k, v] of Object.entries(root.scripts || {})) if (cfg.exclude.some((ex) => v.includes(ex))) delete root.scripts[k];
  fs.writeFileSync(pj, JSON.stringify(root, null, 2) + "\n");
  for (const d of fs.readdirSync(path.join(out, "apps")).map((x) => path.join(out, "apps", x, "package.json")).filter((f) => fs.existsSync(f))) {
    const j = JSON.parse(fs.readFileSync(d, "utf8")); const names = cfg.excludedPackages || [];
    for (const n of names) { if (j.dependencies) delete j.dependencies[n]; }
    fs.writeFileSync(d, JSON.stringify(j, null, 2) + "\n");
  }
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: out, stdio: "ignore" });
}

// 2. Scan every text file; refuse on any hit.
const files = [];
// Binary files: images are scanned through their embedded text (metadata, comments); any other binary type is
// refused, since it can't be checked.
const IMAGES = /\.(png|jpe?g|gif|ico|webp)$/i, unchecked = [];
const strings = (b) => (b.toString("latin1").match(/[\x20-\x7e]{4,}/g) || []).join("\n");
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), rel = path.relative(out, p); if (e.isDirectory()) walk(p); else { const b = fs.readFileSync(p); if (!b.subarray(0, 8000).includes(0)) files.push({ path: rel, text: b.toString("utf8") }); else if (IMAGES.test(p)) files.push({ path: rel, text: strings(b) }); else unchecked.push(rel); } } };
walk(out);
if (unchecked.length) fail(`refusing: binary files that can't be checked: ${unchecked.join(", ")} (add them to publish.exclude or convert them)`);
const hits = findLeaks(files, rulesFor(cfg.terms));
if (hits.length) {
  console.error(`publish: refusing, personal data found in ${new Set(hits.map((h) => h.path)).size} file(s):`);
  for (const h of hits) console.error(`  ${h.path}:${h.line}  ${h.rule}`);
  process.exit(1);
}
console.log(`scan: ${files.length} text files clean (main @ ${short})`);

// 3. Public clone (created once), replaced with the export.
// GitHub redirects a renamed repo's old name, so "owner/command-center" can answer as the renamed private repo.
// Only a repo whose real name is exactly cfg.repo counts, and only a public one may receive a publish.
function target() {
  let r; try { r = JSON.parse(sh("gh", ["api", `repos/${cfg.repo}`])); } catch { return null; }
  if (r.full_name.toLowerCase() !== cfg.repo.toLowerCase()) return null;   // a redirect, not the repo we mean
  if (r.private) fail(`${cfg.repo} is private; publishing only goes to a public repo`);
  return r;
}
const url = `https://github.com/${cfg.repo}.git`;
if (!fs.existsSync(path.join(clone, ".git"))) {
  const exists = target() !== null;
  if (!exists) {
    if (!push) { console.log(`dry run: ${files.length} files would be published to a new public repo ${cfg.repo}.\nFirst publish: npm run publish -- --push --create`); process.exit(0); }
    if (!create) fail(`public repo ${cfg.repo} does not exist yet; first publish: npm run publish -- --push --create`);
    sh("gh", ["repo", "create", cfg.repo, "--public", "--description", "Control AI agent sessions (Claude Code, Codex, Cowork, ChatGPT) from Even Realities G2 glasses"]);
    console.log(`created https://github.com/${cfg.repo}`);
  }
  fs.mkdirSync(clone, { recursive: true }); git(["init", "-q", "-b", "main"], clone); git(["remote", "add", "origin", url], clone);
  try { git(["fetch", "-q", "origin", "main"], clone); git(["reset", "-q", "--hard", "origin/main"], clone); } catch { /* empty repo */ }
} else { git(["fetch", "-q", "origin", "main"], clone); git(["reset", "-q", "--hard", "origin/main"], clone); }
for (const e of fs.readdirSync(clone)) if (e !== ".git") fs.rmSync(path.join(clone, e), { recursive: true, force: true });
fs.cpSync(out, clone, { recursive: true });
git(["add", "-A"], clone);
const stat = git(["diff", "--cached", "--stat"], clone);
if (!stat) { console.log("public repo is already up to date"); process.exit(0); }
console.log(stat.split("\n").slice(-12).join("\n"));
if (!push) { console.log(`\ndry run: nothing pushed. To publish: npm run publish -- --push`); process.exit(0); }
if (!target()) fail(`${cfg.repo} is not the public repo (missing, or a redirect); nothing pushed`);
// Public commits carry the GitHub account's no-reply address, never the email in the local git config.
const me = JSON.parse(sh("gh", ["api", "user"])), who = { name: me.login, email: `${me.id}+${me.login}@users.noreply.github.com` };
const env = { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
execFileSync("git", ["commit", "-q", "-m", `Update (${new Date().toISOString().slice(0, 10)})`], { cwd: clone, env, stdio: ["ignore", "pipe", "pipe"] });
git(["push", "-q", "origin", "main"], clone);
console.log(`published main @ ${short} → https://github.com/${cfg.repo}`);
