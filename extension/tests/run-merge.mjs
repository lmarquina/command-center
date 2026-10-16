// The service worker's list merge (sidebar + every project page), run outside Chrome.
import fs from "node:fs";
import vm from "node:vm";
const src = fs.readFileSync(new URL("../chrome/service-worker.js", import.meta.url), "utf8");
const start = src.indexOf("function mergeSessions"), end = src.indexOf("if (typeof module");
const ctx = {}; vm.runInNewContext(src.slice(start, end) + "\nthis.mergeSessions = mergeSessions; this.fromGroup = fromGroup;", ctx);
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, "-", e.message); } };
const ok = (v, m) => { if (!v) throw new Error(m); };
const now = new Date("2026-10-14T20:00:00");
const sidebar = [{ sessionId: "cse_a", group: "Today" }, { sessionId: "cse_b", group: "Today" }, { sessionId: "chat:y", group: "Yesterday" }, { sessionId: "chat:d", group: "Oct 8" }, { sessionId: "cse_old", group: "Older" }, { sessionId: "cse_p", group: "Older" }];
const proj = [{ sessionId: "chat:tools", updatedAt: "2026-10-14T19:59:00.000Z", project: "Bench" }, { sessionId: "cse_p", updatedAt: "2026-09-01T10:00:00.000Z" }, { sessionId: "cse_q" }];
const rows = ctx.mergeSessions(sidebar, proj, {}, now);
const by = Object.fromEntries(rows.map((r) => [r.sessionId, r.updatedAt]));
t("sidebar order is kept within Today", () => ok(by.cse_a > by.cse_b, JSON.stringify(by)));
t("Yesterday and dated groups sit below Today, in order", () => ok(by.cse_b > by["chat:y"] && by["chat:y"] > by["chat:d"], JSON.stringify(by)));
t("a dated group in the future means last year", () => { const d = new Date(ctx.fromGroup("Dec 30", 0, now)); ok(d.getFullYear() === 2025 && d.getMonth() === 11 && d.getDate() === 30, d.toString()); });
t("project pages give exact times, also to a sidebar row they share", () => ok(by["chat:tools"] === "2026-10-14T19:59:00.000Z" && by.cse_p === "2026-09-01T10:00:00.000Z", JSON.stringify(by)));
t("Older with no project time stays undated; every session appears once", () => ok(by.cse_old === undefined && rows.length === 8, rows.length));
t("sorted by updatedAt, a just-active project session ranks with today's sidebar rows", () => {
  const sorted = [...rows].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).map((r) => r.sessionId);
  ok(sorted.indexOf("chat:tools") < sorted.indexOf("chat:y"), sorted.join(","));
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
