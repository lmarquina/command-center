// One configuration for every service: config/default.json, overridden by config/local.json (gitignored,
// this machine only). Objects merge key by key; arrays and scalars are replaced.
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.mjs";

export function merge(base, over) {
  if (over === undefined) return base;
  if (!isObj(base) || !isObj(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function loadConfig(dir = process.env.CC_CONFIG_DIR || path.join(REPO_ROOT, "config")) {
  const read = (f) => { const p = path.join(dir, f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined; };
  const base = read("default.json");
  if (!base) throw Object.assign(new Error(`no default.json in ${dir}`), { code: "CONFIG_MISSING" });
  return merge(base, read("local.json"));
}
