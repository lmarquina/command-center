// Where runtime state lives (sockets, locks, logs, tokens). Gitignored; override with CC_RUN_DIR.
import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
export const RUN_DIR = process.env.CC_RUN_DIR || path.join(REPO_ROOT, "run");
export function runPath(...parts) {
  const p = path.join(RUN_DIR, ...parts);
  fs.mkdirSync(parts.length > 1 ? path.dirname(p) : RUN_DIR, { recursive: true, mode: 0o700 });
  return p;
}
