// Finds personal data in files about to be published. Built-in rules catch the generic kinds (addresses, keys,
// home paths); the owner's own list (names, hostnames, ids) comes from config/local.json, which is never published.
export const BUILT_IN = [
  { name: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Tailscale hostname", re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net\b/i, allow: /(^|\.)example\.ts\.net$/i },
  { name: "Tailscale/CGNAT address", re: /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
  { name: "LAN address", re: /\b(192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, skipPaths: /(^|\/)(uv\.lock|package-lock\.json)$/ },   // lockfile version numbers look like addresses
  { name: "email address", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, allow: /@(example\.(com|org)|localhost|anthropic\.com)$/i },
  { name: "home directory path", re: /\/Users\/[a-z0-9._-]+/i, allow: /^\/Users\/(me|you|someone|Shared)$/i },
  { name: "API key", re: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{10,})\b/ },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Owner's terms become case-insensitive whole-word rules. */
export function rulesFor(terms = []) {
  return [...BUILT_IN, ...terms.filter((t) => String(t).trim()).map((t) => ({ name: "personal term", re: new RegExp(`(^|[^A-Za-z0-9])${escape(String(t).trim())}($|[^A-Za-z0-9])`, "i") }))];
}

/**
 * @param {{path:string, text:string}[]} files
 * @returns {{path:string, line:number, rule:string}[]}  where personal data was found (the match itself is not repeated)
 */
export function findLeaks(files, rules) {
  const hits = [];
  // Every match counts: an allowed placeholder earlier on a line must not hide a real value after it.
  const leaks = (text, r) => [...text.matchAll(new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"))].some((m) => !(r.allow && r.allow.test(m[0])));
  for (const f of files) {
    for (const r of rules) if (leaks(f.path, r)) hits.push({ path: f.path, line: 0, rule: `${r.name} (file name)` });   // names too
    f.text.split("\n").forEach((line, i) => {
      for (const r of rules) {
        if (r.skipPaths && r.skipPaths.test(f.path)) continue;
        if (leaks(line, r)) hits.push({ path: f.path, line: i + 1, rule: r.name });
      }
    });
  }
  return hits;
}
