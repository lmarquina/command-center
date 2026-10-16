// DesktopLauncher against a simulated Claude Desktop (no real UI is touched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DesktopLauncher } from "../src/desktopLauncher.mjs";

const P1 = "01a09232-33e5-76f6-bbaa-9d2a7546b6eb", P2 = "02b09232-33e5-76f6-bbaa-9d2a7546b6eb";
const KNOWN_FOLDER = "/Users/me/Documents";

/** Minimal state machine of Desktop's new-task flow, answering the scripts/ax commands the launcher uses. */
function fakeDesktop({ draft = "", sheetOnStart = false, composerEcho = (v) => v, dialog = null, projects = [{ name: "Hartwell Kramer", id: P1 }], folders = [KNOWN_FOLDER], attachedOnNew = null } = {}) {
  const s = { url: "https://claude.ai/chat/11111111-2222-3333-4444-555555555555", composer: "existing chat text", menu: false, query: "", chip: null, sheet: false, dialog, pressed: [] };
  const base = (f) => f.split("/").pop();
  const run = async ([cmd, a, b, c]) => { if (process.env.DL_DEBUG) console.log("AX", cmd, a ?? "", b ?? "", JSON.stringify({ chip: s.chip, menu: s.menu }));
    const fail = (m) => { throw new Error(m); };
    switch (cmd) {
      case "url": return s.url + "\n";
      case "dump": return s.sheet ? "AXWindow\n  AXSheet \"alert\"\n" : "AXWindow\n";
      case "find":
        if (a === "AXGroup") return s.dialog ? `[0] AXGroup/AXApplicationDialog "${s.dialog}"\n` : "";
        if (a === "AXComboBox") return s.menu ? `[0] AXComboBox "Search or create a project"\n` : "";
        if (a === "AXPopUpButton") return ["Add files, connectors, and more", "Microphone", s.chip || "Project or folder", "Auto"].filter((l) => l.includes(b)).map((l, i) => `[${i}] AXPopUpButton "${l}" #x`).join("\n") + "\n";
        if (a === "AXButton" && b.startsWith("Claude Desktop")) return s.url.includes("/cowork/") ? `[0] AXButton "Claude Desktop (macOS), Connected"\n` : "";
        if (a === "AXStaticText") {
          if (!s.menu) return "";
          const q = s.query.toLowerCase(); const rows = [];
          projects.filter((p) => p.name.toLowerCase().includes(q)).forEach((p) => rows.push(`[0] AXStaticText = ${p.name} , press Option+Enter to set as default #_r_x_-cp-${p.id} .c`));
          folders.filter((f) => base(f).toLowerCase().includes(q)).forEach((f) => rows.push(`[0] AXStaticText = ${base(f)} ${f} , press Option… #_r_x_-recent-${encodeURIComponent(f)} .c`));
          return rows.join("\n") + "\n";
        }
        return "";
      case "pressexact":
        s.pressed.push(b);
        if (b === "New") { s.url = "https://claude.ai/new"; s.composer = draft; s.chip = attachedOnNew ?? s.chip; s.menu = false; return "ok"; } // a project stays attached across New
        if (b === (s.chip || "Project or folder")) { s.menu = !s.menu; s.query = ""; return "ok"; } // chip and empty button open the same picker
        if (b === "Start task" || b === "Send message") {
          if (s.url !== "https://claude.ai/new" || (b === "Start task") !== !!s.chip) fail("expected 1 exact match, found 0"); // Desktop shows one or the other
          s.url = s.chip ? "https://claude.ai/cowork/cse_01SIMULATED" : "https://claude.ai/chat/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; s.sheet = sheetOnStart; return "ok";
        }
        if (/^(Allow|Always allow|Continue)$/.test(b)) fail("launcher must never click consent buttons");
        return fail("expected 1 exact match, found 0");
      case "pressid": {
        if (!s.menu) fail("no match");
        const p = projects.find((x) => a === `-cp-${x.id}` && x.name.toLowerCase().includes(s.query.toLowerCase()));
        const f = folders.find((x) => a === "-recent-" + encodeURIComponent(x) && base(x).toLowerCase().includes(s.query.toLowerCase()));
        if (!p && !f) fail("no match");
        const lbl = p ? `${p.name} +1` : base(f);
        // real Desktop: a project chip reads "<name> +1"; clicking the attached entry again detaches it; picking closes the menu
        s.pressed.push(a); s.chip = s.chip === lbl ? null : lbl; s.menu = false; return "ok";
      }
      case "value": return s.composer + "\n";
      case "setvalue":
        if (a === "AXComboBox") { s.query = c; return "ok"; }
        s.composer = composerEcho(c); return "ok";
      default: return fail("unknown " + cmd);
    }
  };
  return { s, run };
}
const launcher = (d) => new DesktopLauncher({ run: d.run, stepTimeoutMs: 300, startTimeoutMs: 300, pollMs: 10, log: process.env.DL_DEBUG ? console.log : () => {} });

test("no folder: New → exact prompt → Start → identity from URL; picker never touched", async () => {
  const d = fakeDesktop();
  const r = await launcher(d).create({ firstMessage: "Plan my week\nwith two lines" });
  assert.equal(r.nativeId, "chat:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"); assert.equal(r.target, "none");
  assert.deepEqual(d.s.pressed, ["New", "Start task", "Send message"]); // no folder → "Send message"
});
test("existing project: picked by its stable id via the picker search", async () => {
  const d = fakeDesktop();
  const r = await launcher(d).create({ firstMessage: "x", project: "Hartwell Kramer" });
  assert.equal(r.target, `project:${P1}`);
  assert.deepEqual(d.s.pressed, ["New", "Project or folder", `-cp-${P1}`, "Start task"]);
  assert.equal(r.nativeId, "cse_01SIMULATED"); assert.equal(r.environment, "Claude Desktop (macOS), Connected");
});
test("project name must match exactly one project (or the given id); otherwise nothing starts", async () => {
  const dup = fakeDesktop({ projects: [{ name: "WK", id: P1 }, { name: "WK", id: P2 }] });
  await assert.rejects(launcher(dup).create({ firstMessage: "x", project: "WK" }), { code: "PROJECT_AMBIGUOUS" });
  assert.ok(!dup.s.pressed.includes("Start task")); assert.equal(dup.s.menu, false);
  const ok = fakeDesktop({ projects: [{ name: "WK", id: P1 }, { name: "WK", id: P2 }] });
  assert.equal((await launcher(ok).create({ firstMessage: "x", project: "WK", projectId: P2 })).target, `project:${P2}`);
  const none = fakeDesktop();
  await assert.rejects(launcher(none).create({ firstMessage: "x", project: "Hartwell" }), { code: "PROJECT_NOT_FOUND" }); // prefix ≠ exact name
  assert.ok(!none.s.pressed.includes("Start task"));
});
test("existing folder Desktop knows: picked by path; unknown folder fails closed", async () => {
  const d = fakeDesktop();
  assert.equal((await launcher(d).create({ firstMessage: "x", cwd: KNOWN_FOLDER })).target, `folder:${KNOWN_FOLDER}`);
  const u = fakeDesktop();
  await assert.rejects(launcher(u).create({ firstMessage: "x", cwd: "/Users/me/elsewhere" }), { code: "FOLDER_NOT_FOUND" });
  assert.ok(!u.s.pressed.includes("Start task")); assert.equal(u.s.menu, false);
});
test("no-folder task refuses if something is already attached on the new-task page", async () => {
  const d = fakeDesktop({ attachedOnNew: "Weekly Newsletter +1" });
  await assert.rejects(launcher(d).create({ firstMessage: "x" }), { code: "PICKER_NOT_FOUND" });
  assert.ok(!d.s.pressed.includes("Start task"));
});
test("project already attached on the new-task page: kept if its name is unique (no toggle); switching to another project works", async () => {
  const same = fakeDesktop({ attachedOnNew: "Hartwell Kramer +1" });
  const r = await launcher(same).create({ firstMessage: "x", project: "Hartwell Kramer" });
  assert.equal(r.target, `project:${P1}`); assert.ok(!same.s.pressed.includes(`-cp-${P1}`));
  const other = fakeDesktop({ attachedOnNew: "Weekly Newsletter +1" });
  const r2 = await launcher(other).create({ firstMessage: "x", project: "Hartwell Kramer" });
  assert.equal(r2.target, `project:${P1}`); assert.ok(other.s.pressed.includes(`-cp-${P1}`)); assert.equal(other.s.chip, "Hartwell Kramer +1");
});
test("launcher detaches what it attached if it fails before Start (draft left clean)", async () => {
  const d = fakeDesktop({ composerEcho: (v) => v.slice(0, 3) });
  await assert.rejects(launcher(d).create({ firstMessage: "a longer prompt", project: "Hartwell Kramer" }), { code: "COMPOSER_MISMATCH" });
  assert.equal(d.s.chip, null); assert.equal(d.s.menu, false); assert.ok(!d.s.pressed.includes("Start task"));
});
test("never overwrites a draft in the new-task composer", async () => {
  const d = fakeDesktop({ draft: "the user's half-written idea" });
  await assert.rejects(launcher(d).create({ firstMessage: "x" }), { code: "DRAFT_PRESENT" });
  assert.ok(!d.s.pressed.includes("Start task"));
});
test("an open dialog stops the launcher before it does anything", async () => {
  const d = fakeDesktop({ dialog: "Another app attached “x”" });
  await assert.rejects(launcher(d).create({ firstMessage: "x" }), { code: "DESKTOP_BUSY" });
  assert.deepEqual(d.s.pressed, []);
});
test("consent sheet after Start → CONSENT_REQUIRED with the task id, never clicked", async () => {
  const d = fakeDesktop({ sheetOnStart: true });
  await assert.rejects(launcher(d).create({ firstMessage: "x", project: "Hartwell Kramer" }), (e) => e.code === "CONSENT_REQUIRED" && e.nativeId === "cse_01SIMULATED");
  assert.ok(!d.s.pressed.some((b) => /Allow|Continue/.test(b)));
});
test("composer that does not read back exactly → no Start", async () => {
  const d = fakeDesktop({ composerEcho: (v) => v.slice(0, 5) });
  await assert.rejects(launcher(d).create({ firstMessage: "a longer prompt" }), { code: "COMPOSER_MISMATCH" });
  assert.ok(!d.s.pressed.includes("Start task"));
});
test("project and folder together is rejected up front", async () => {
  const d = fakeDesktop();
  await assert.rejects(launcher(d).create({ firstMessage: "x", project: "Hartwell Kramer", cwd: KNOWN_FOLDER }), { code: "BAD_REQUEST" });
  assert.deepEqual(d.s.pressed, []);
});
test("operations are serialized (Desktop is one shared window)", async () => {
  const d = fakeDesktop(); const l = launcher(d);
  await Promise.all([l.create({ firstMessage: "one" }), l.create({ firstMessage: "two", project: "Hartwell Kramer" })]);
  assert.deepEqual(d.s.pressed, ["New", "Start task", "Send message", "New", "Project or folder", `-cp-${P1}`, "Start task"]);
});
