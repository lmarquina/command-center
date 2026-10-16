import fs from "node:fs";

// Presentation mode, for demos and screen recordings: sessions that are not part of the demo keep their place,
// harness and status, but their titles and text are masked, so a busy real list can be shown without revealing it.
// A session is "shown" if its working folder is under one of `cwdPrefixes`, its title matches one of `titles`
// (regular expressions), or it was created while presentation mode was on.

const block = (s) => String(s || "").replace(/[^\s]/g, "█").replace(/█{2,}/g, (m) => m.slice(0, Math.min(m.length, 9))).slice(0, 40) || "█████";

export class Presentation {
  /** @param {{enabled?: boolean, cwdPrefixes?: string[], titles?: string[], idsFile?: string}} cfg
   *  idsFile: a JSON file whose string values are session ids to show (re-read when it changes) */
  constructor(cfg = {}) {
    this.enabled = !!cfg.enabled;
    this.prefixes = (cfg.cwdPrefixes || []).map((p) => p.replace(/^~(?=\/)/, process.env.HOME || "~"));
    this.titles = (cfg.titles || []).map((t) => new RegExp(t, "i"));
    this.created = new Set();
    this.idsFile = cfg.idsFile ? cfg.idsFile.replace(/^~(?=\/)/, process.env.HOME || "~") : null; this.ids = new Set(); this.idsAt = 0;
  }
  #listed(id) {
    if (!this.idsFile) return false;
    try { const m = fs.statSync(this.idsFile).mtimeMs; if (m !== this.idsAt) { this.ids = new Set(Object.values(JSON.parse(fs.readFileSync(this.idsFile, "utf8"))).filter((v) => typeof v === "string")); this.idsAt = m; } } catch { this.ids = new Set(); }
    return this.ids.has(id);
  }
  shows(s) {
    if (!this.enabled) return true;
    return this.created.has(s.sessionId) || this.#listed(s.sessionId) || (s.cwd && this.prefixes.some((p) => s.cwd === p || s.cwd.startsWith(p + "/"))) || this.titles.some((r) => r.test(s.title || ""));
  }
  /** A session row as it may be shown. */
  row(s) { return this.shows(s) ? s : { ...s, title: block(s.title), cwd: undefined, project: s.project ? block(s.project) : undefined, masked: true }; }
  /** An attention item (its text is the request or result). */
  item(a, known) { return !this.enabled || (known && this.shows(known)) ? a : { ...a, text: block(a.text), masked: true }; }
  /** Event payloads carry text (streamed replies, request descriptions): blank them for masked sessions. */
  event(e, known) {
    if (!this.enabled || (known && this.shows(known))) return e;
    const out = { ...e, masked: true };
    for (const k of ["text", "title", "result", "preview"]) if (out[k]) out[k] = block(out[k]);
    if (out.request) out.request = { ...out.request, description: block(out.request.description) };
    return out;
  }
}
