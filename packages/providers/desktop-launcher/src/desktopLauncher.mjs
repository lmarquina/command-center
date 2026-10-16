// Desktop launcher (POC 7): starts a new Cowork task bound to THIS Mac by driving Claude Desktop's own UI via
// macOS Accessibility (scripts/ax). Continuing an existing task goes through the Chrome bridge (same cloud session).
//
// Targets (user, 2026-10-07): a plain task with NO folder, or an EXISTING Cowork project / folder chosen through
// Desktop's own picker (its search box). Projects are matched by their stable id (DOM id "-cp-<uuid>"), never by
// name alone. Desktop's own consent dialogs are never clicked: if one appears we stop with CONSENT_REQUIRED.
//
// Fail closed at every step: exact-name presses only, the page must be claude.ai/new with an empty composer before
// typing, the composer must read back exactly, the folder chip must match, and the new task's identity is the
// cse_ id from the page URL (never the title).
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

// Accessibility helper: built from ../native/ax.swift by `npm run build:ax -w @command-center/desktop-launcher`.
const AX = process.env.CC_AX_BIN || new URL("../native/ax", import.meta.url).pathname;
const ID_URL = /^https:\/\/claude\.ai\/(?:cowork\/(cse_[A-Za-z0-9]+)|chat\/([0-9a-f-]{36}))$/;
const MAC_ENV = /^Claude Desktop \(macOS\), (Connected|Disconnected|Offline)$/;
const err = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DesktopLauncher {
  /** @param {object} o  run: optional (args) => Promise<string> replacing scripts/ax (tests use a simulated Desktop) */
  constructor({ ax = AX, run, log = () => {}, stepTimeoutMs = 15000, startTimeoutMs = 45000, pollMs = 400 } = {}) {
    Object.assign(this, { axPath: ax, run, log, stepTimeoutMs, startTimeoutMs, pollMs });
    this.queue = Promise.resolve(); // Desktop's window is one shared UI: one launcher operation at a time
  }

  ax(...args) {
    if (this.run) return this.run(args).catch((e) => { throw err("AX_FAILED", `ax ${args[0]}: ${e.message}`); });
    return new Promise((resolve, reject) => execFile(this.axPath, args, { encoding: "utf8", timeout: 20000 }, (e, out, stderr) =>
      e ? reject(err("AX_FAILED", `ax ${args[0]}: ${(stderr || e.message).trim()}`)) : resolve(out)));
  }
  async tryAx(...args) { try { return await this.ax(...args); } catch { return null; } }
  async waitFor(fn, what, ms = this.stepTimeoutMs) {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw err("DESKTOP_TIMEOUT", `timed out waiting for ${what}`); await sleep(this.pollMs); }
  }

  async url() { return ((await this.tryAx("url")) || "").trim(); }
  async blockingDialog() {
    const d = (await this.tryAx("dump", "3")) || "";
    if (/AXSheet/.test(d)) return "a macOS sheet";
    const g = (await this.tryAx("find", "AXGroup", "")) || "";
    const m = g.match(/AXApplicationDialog "([^"]*)"/);
    return m ? m[1] : null;
  }
  async environment() {
    const b = (await this.tryAx("find", "AXButton", "Claude Desktop (macOS)")) || "";
    const m = b.match(/"(Claude Desktop \(macOS\), [A-Za-z]+)"/);
    return m && MAC_ENV.test(m[1]) ? m[1] : null;
  }

  /** @param {{firstMessage:string, project?:string, projectId?:string, cwd?:string}} o  no project/cwd = plain task (no folder)
   *  @returns {{nativeId:string, environment:string, target:string, url:string}} */
  create(o) { const run = this.queue.then(() => this.#create(o)); this.queue = run.catch(() => {}); return run; }

  async #create(o) {
    this.attached = null; this.started = false;
    try { return await this.#createInner(o); }
    catch (e) { if (this.attached && !this.started) await this.detach().catch((d) => this.log("desktop-launch cleanup failed", d.message)); throw e; }
  }
  /** Undo our own attach on the unsent new-task draft (clicking the selected entry again detaches it). */
  async detach() {
    const { domId, query } = this.attached;
    await this.openPicker(); await this.search(query); await this.ax("pressid", domId);
    await this.waitFor(() => this.nothingAttached(), "the draft to be clean");
    this.log("desktop-launch", "cleanup: detached", domId);
  }

  async #createInner({ firstMessage, project, projectId, cwd }) {
    const t0 = Date.now();
    const step = (s) => this.log("desktop-launch", s, `${Date.now() - t0}ms`);
    if (!firstMessage || !String(firstMessage).trim()) throw err("BAD_REQUEST", "a first message is required to start a Cowork task");
    if (project && cwd) throw err("BAD_REQUEST", "choose a project or a folder, not both");
    const folder = cwd ? path.resolve(cwd) : null;
    // 1. Desktop reachable, no dialog in the way
    if (!(await this.url())) throw err("DESKTOP_UNAVAILABLE", "Claude Desktop's window is not reachable (not running, minimized, or on another Space)");
    const d0 = await this.blockingDialog();
    if (d0) throw err("DESKTOP_BUSY", `Claude Desktop is showing a dialog ("${d0}"); not acting`);

    // 2. Fresh new-task page with an empty composer (never type into an existing task or someone's draft)
    await this.ax("pressexact", "AXButton", "New"); step("new");
    await this.waitFor(async () => (await this.url()) === "https://claude.ai/new", "the new-task page");
    const draft = await this.waitFor(async () => { const v = await this.tryAx("value", "AXTextArea", "Write your prompt"); return v === null ? null : { v }; }, "the composer");
    if (draft.v.trim()) throw err("DRAFT_PRESENT", "Claude Desktop's new-task composer already has a draft; not overwriting it");

    // 3. Target via Desktop's own picker (search box covers projects and known folders)
    let target = "none";
    if (project) target = await this.pickProject(project, projectId);
    else if (folder) target = await this.pickFolder(folder);
    else if (!(await this.nothingAttached())) throw err("PICKER_NOT_FOUND", "a project or folder is already attached on the new-task page; not starting a no-folder task");
    step(`target ${target}`);
    const d1 = await this.blockingDialog();
    if (d1) throw err("CONSENT_REQUIRED", `Claude Desktop asks for consent ("${d1}"); approve it on the Mac. Not clicking it.`);

    // 4. Prompt, read back exactly
    await this.ax("setvalue", "AXTextArea", "Write your prompt", firstMessage);
    const back = (await this.ax("value", "AXTextArea", "Write your prompt")).replace(/\n$/, "");
    if (norm(back) !== norm(firstMessage)) throw err("COMPOSER_MISMATCH", "the composer did not read back the exact prompt; not starting");
    if ((await this.url()) !== "https://claude.ai/new" || !(await this.targetStillSet(target))) throw err("STATE_CHANGED", "the new-task page changed before Start; not starting");
    step("prompt");

    // 5. Start, then identity from the URL (cse_ id), environment must be this Mac
    // With a project/folder the button is "Start task"; with no folder it is "Send message". Exactly one must exist.
    const startBtn = (await this.tryAx("pressexact", "AXButton", "Start task")) ? "Start task" : (await this.tryAx("pressexact", "AXButton", "Send message")) ? "Send message" : null;
    this.started = !!startBtn;
    if (!startBtn) throw err("START_NOT_FOUND", "neither 'Start task' nor 'Send message' is available; not starting");
    step(`start (${startBtn})`);
    let sheet = null;
    const u = await this.waitFor(async () => {
      const x = await this.url(); if (ID_URL.test(x)) return x;
      sheet = await this.blockingDialog(); return sheet ? "dialog" : null;
    }, "the new task's id", this.startTimeoutMs);
    if (u === "dialog") throw err("CONSENT_REQUIRED", `Claude Desktop asks for consent ("${sheet}"); approve it on the Mac. Not clicking it.`);
    const [, cse, chat] = u.match(ID_URL); const nativeId = cse || `chat:${chat}`; // bridge ids: cse_… or chat:<uuid>
    const environment = await this.waitFor(() => this.environment(), "the device binding", 10000).catch(() => null);
    if (environment && !/Connected$/.test(environment)) this.log("desktop-launch warning", environment);
    const late = await this.blockingDialog();
    step(`started ${nativeId} ${environment || "(environment unknown)"}${late ? ` (dialog: ${late})` : ""}`);
    if (late) throw err("CONSENT_REQUIRED", `task ${nativeId} started but Claude Desktop asks for consent ("${late}"); approve it on the Mac`, { nativeId });
    return { nativeId, environment, target, url: u, ms: Date.now() - t0 };
  }

  // ---------- picker ----------
  /** Opens Desktop's project/folder picker from the empty "Project or folder" button or from the current chip
   *  (the popup right after "Microphone"); verifies the menu that opened is the picker (it has the search box). */
  async openPicker() {
    this.pickerBtn = "Project or folder";
    if (!(await this.tryAx("pressexact", "AXPopUpButton", "Project or folder"))) {
      const labels = ((await this.tryAx("find", "AXPopUpButton", "")) || "").split("\n").map((l) => (l.match(/AXPopUpButton "(.*?)"/) || [])[1]).filter(Boolean);
      const chip = labels[labels.indexOf("Microphone") + 1];
      if (!chip || labels.indexOf("Microphone") < 0) throw err("PICKER_NOT_FOUND", "cannot find the project/folder picker on the new-task page");
      this.pickerBtn = chip;
      await this.ax("pressexact", "AXPopUpButton", chip);
    }
    await this.waitFor(() => this.tryAx("find", "AXComboBox", "Search or create a project"), "the project/folder menu");
  }
  async closePicker() { await this.tryAx("setvalue", "AXComboBox", "Search or create a project", ""); await this.tryAx("pressexact", "AXPopUpButton", this.pickerBtn || "Project or folder"); }
  async pickerOpen() { return !!(await this.tryAx("find", "AXComboBox", "Search or create a project")); }
  async search(q) { await this.ax("setvalue", "AXComboBox", "Search or create a project", q); await sleep(Math.max(this.pollMs, 600)); }
  /** Rows of the picker list: [{label, id}] (label = visible text before ", press Option+Enter…"). */
  async rows() {
    const out = (await this.tryAx("find", "AXStaticText", "")) || "";
    return out.split("\n").map((l) => l.match(/= (.*?) #(\S+)/)).filter(Boolean).map((m) => ({ label: m[1].replace(/ , press Option.*$/, "").trim(), id: m[2] }));
  }
  async pickProject(name, projectId) {
    await this.openPicker();
    try {
      await this.search(name);
      const hits = (await this.rows()).filter((r) => /-cp-[0-9a-f-]{36}$/.test(r.id) && r.label === name);
      const ids = [...new Set(hits.map((h) => h.id.match(/-cp-([0-9a-f-]{36})$/)[1]))];
      if (projectId && !ids.includes(projectId)) throw err("PROJECT_NOT_FOUND", `no project "${name}" with id ${projectId}`);
      if (!projectId && ids.length !== 1) throw err(ids.length ? "PROJECT_AMBIGUOUS" : "PROJECT_NOT_FOUND", `${ids.length} projects named "${name}"`, { projectIds: ids });
      const id = projectId || ids[0];
      this.picked = { kind: "project", name };
      if (await this.chip(name)) { await this.closePicker(); return `project:${id}`; } // already attached; name is unique (or id-checked) → keep, don't toggle
      await this.ax("pressid", `-cp-${id}`); this.attached = { domId: `-cp-${id}`, query: name };
      await this.waitFor(() => this.chip(name), "the project chip");
      this.picked = { kind: "project", name };
      return `project:${id}`;
    } catch (e) { if (await this.pickerOpen()) await this.closePicker(); throw e; }
  }
  async pickFolder(folder) {
    await this.openPicker();
    try {
      await this.search(path.basename(folder));
      if (await this.tryAx("pressid", "-recent-" + encodeURIComponent(folder))) this.attached = { domId: "-recent-" + encodeURIComponent(folder), query: path.basename(folder) };
      else throw err("FOLDER_NOT_FOUND", `${folder} is not a folder Desktop knows; use a project, or no folder`);
      await this.waitFor(() => this.chip(path.basename(folder)), "the folder chip");
      this.picked = { kind: "folder", name: path.basename(folder) };
      return `folder:${folder}`;
    } catch (e) { if (await this.pickerOpen()) await this.closePicker(); throw e; }
  }
  async targetStillSet(target) {
    if (target === "none") return this.nothingAttached();
    return this.chip(this.picked.name);
  }
  async nothingAttached() { return /AXPopUpButton "Project or folder"/.test((await this.tryAx("find", "AXPopUpButton", "Project or folder")) || ""); }
  async chip(label) {
    const b = (await this.tryAx("find", "AXPopUpButton", label)) || "";
    // Desktop labels the chip "<name>" or "<name> +N" (a project also attaches its folder(s))
    return b.split("\n").some((l) => { const m = l.match(/AXPopUpButton "(.*?)"/); return m && (m[1] === label || new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\+\\d+$`).test(m[1])); });
  }
}

const norm = (s) => String(s).replace(/\r\n/g, "\n").replace(/\s+$/g, "").trim();
