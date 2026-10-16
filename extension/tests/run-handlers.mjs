// Guard: every RPC method the service worker forwards to the Cowork content script must exist in its handler table.
import fs from "node:fs";
const cs = fs.readFileSync(new URL("../chrome/content-script.js", import.meta.url), "utf8");
const table = cs.slice(cs.indexOf("const handlers = {"), cs.indexOf("// ---- Cowork step-group helpers"));
const required = ["ping", "identity", "doctor", "list", "navigate", "read", "status", "send", "answer", "approve", "deny", "stop", "steps", "stepOpen", "snapshot", "mark", "health", "projectsIndex", "projectPage"];
const missing = required.filter((m) => !new RegExp(`\\n\\s{4}${m}: `).test(table));
if (missing.length) { console.log(`FAIL content-script handlers missing: ${missing.join(", ")}`); process.exit(1); }
console.log(`PASS content-script has all ${required.length} handlers\n1 passed, 0 failed`);
