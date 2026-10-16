// Regression tests: run chrome/selectors.js against sanitized claude.ai DOM captures.
// Usage: npm test   (from chrome-extension-bridge/)
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = fs.readFileSync(path.join(ROOT, "chrome/selectors.js"), "utf8");
const fx = (name) => fs.readFileSync(path.join(ROOT, "fixtures", name), "utf8");

function load(html, mutate) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Fixture - Claude</title></head><body>${html}</body></html>`, { url: "https://claude.ai/chat/00000000-0000-4000-8000-000000000000", runScripts: "outside-only" });
  if (mutate) mutate(dom.window.document);
  dom.window.eval(SRC);
  return { D: dom.window.CoworkDom, doc: dom.window.document };
}

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, what) => { if (!v) throw new Error(what); };

const STATES = [
  ["idle.html", "idle"],
  ["working.html", "working"],
  ["waiting-input.html", "waiting_for_input"],
  ["approval.html", "approval_required"],
  ["approval-stale.html", "idle"],
  ["interrupted.html", "interrupted"],
];
for (const [file, want] of STATES) {
  if (!fs.existsSync(path.join(ROOT, "fixtures", file))) { console.log(`SKIP ${file} (not captured)`); continue; }
  t(`status ${file} → ${want}`, () => eq(load(fx(file)).D.status(load(fx(file)).doc).status, want, "status"));
}

t("approval: approve/deny controls resolve uniquely at >= action threshold", () => {
  const { D, doc } = load(fx("approval.html"));
  const card = D.resolve(doc, "permissionGroup");
  eq(card.count, 1, "card count");
  for (const b of ["approve", "deny"]) {
    const r = D.resolve(card.el, b);
    ok(r.el && r.count === 1 && r.confidence >= D.ACTION_MIN_CONF, `${b} resolve ${JSON.stringify({ count: r.count, confidence: r.confidence })}`);
  }
});
t("approval-stale: card present but reported staleCard, not pending", () => {
  const { D, doc } = load(fx("approval-stale.html"));
  const s = D.status(doc);
  ok(s.staleCard === true && s.status !== "approval_required", JSON.stringify(s));
});
t("waiting-input: question text + 2 options, no Skip/Minimize", () => {
  const { D, doc } = load(fx("waiting-input.html"));
  const s = D.status(doc);
  eq(s.question.options.length, 2, "options");
  ok(!s.question.options.some((o) => /^(Skip|Minimize)$/.test(o)), "Skip/Minimize leaked into options");
});
t("working: stop control resolves with high confidence", () => {
  const { D, doc } = load(fx("working.html"));
  const r = D.resolve(doc, "stop");
  ok(r.el && r.confidence >= 90, JSON.stringify({ ...r, el: !!r.el }));
});
t("transcript: messages have roles, assistant prose separated from tool lines", () => {
  const { D, doc } = load(fx("idle.html"));
  const m = D.readMessages(doc);
  ok(m.length > 2, "few messages");
  ok(m.every((x) => x.role === "user" || x.role === "assistant"), "unknown role present");
  ok(m.filter((x) => x.role === "assistant").every((x) => typeof x.turnKey === "string"), "assistant without turnKey");
});
t("composer resolves via data-testid (confidence 100)", () => {
  const { D, doc } = load(fx("idle.html"));
  eq(D.resolve(doc, "composer").confidence, 100, "composer confidence");
});

// ---- fail-closed on unknown / changed UI ----
t("duplicated approval card → ambiguous → below action threshold (fail closed)", () => {
  const { D, doc } = load(fx("approval.html"), (d) => { const c = d.querySelector('[data-testid="hub-approval-card"]'); c.parentElement.appendChild(c.cloneNode(true)); });
  const r = D.resolve(doc, "permissionGroup");
  ok(r.count === 2 && r.confidence < D.ACTION_MIN_CONF, JSON.stringify({ count: r.count, confidence: r.confidence }));
});
t("renamed Allow button → approve control not found (no guessing)", () => {
  const { D, doc } = load(fx("approval.html"), (d) => {
    const w = d.createTreeWalker(d.body, 4);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.trim() === "Allow once") n.nodeValue = "Permit";
  });
  const card = D.resolve(doc, "permissionGroup");
  const r = D.resolve(card.el, "approve");
  ok(!r.el || r.confidence < D.ACTION_MIN_CONF, "approve still resolved after rename");
});
t("stripped data-testid/aria → doctor degrades (not read-write)", () => {
  const { D, doc } = load(fx("idle.html"), (d) => d.querySelectorAll("[data-testid],[role=article]").forEach((e) => { e.removeAttribute("data-testid"); e.removeAttribute("role"); e.removeAttribute("aria-label"); }));
  const r = D.doctor(doc);
  ok(r.mode !== "read-write" || r.checks.composer !== "PASS", JSON.stringify(r.checks));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
