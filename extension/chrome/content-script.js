// Cowork Bridge content script: DOM actions + MutationObserver events for one claude.ai tab.
// All DOM knowledge comes from selectors.js (CoworkDom). No LLM, no coordinates.
(() => {
  if (globalThis.__coworkBridgeLoaded) return;
  globalThis.__coworkBridgeLoaded = true;
  const D = globalThis.CoworkDom, P = globalThis.CoworkProtocol, E = P.ERR;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fail(code, message, details) { const e = new Error(message); e.code = code; e.details = details; throw e; }
  // Hidden tabs: Chrome throttles timers (≈1/min after 5 min hidden), so polling waits can stall for minutes.
  // Wait on DOM mutations instead (delivered promptly even in background tabs), with timers only as a fallback.
  function waitFor(fn, timeoutMs = 8000, stepMs = 100) {
    const v0 = fn(); if (v0) return Promise.resolve(v0);
    return new Promise((resolve) => {
      const t0 = Date.now(); let done = false;
      const finish = (v) => { if (done) return; done = true; mo.disconnect(); clearInterval(iv); clearTimeout(to); resolve(v); };
      const check = () => { let v = null; try { v = fn(); } catch { v = null; } if (v) finish(v); else if (Date.now() - t0 > timeoutMs) finish(null); };
      const mo = new MutationObserver(check);
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const iv = setInterval(check, stepMs); const to = setTimeout(check, timeoutMs + 5);
    });
  }
  // A short pause that ends on the first DOM activity after `ms` (or the throttled timer, whichever comes first).
  const settle = (ms) => { const t0 = Date.now(); return waitFor(() => Date.now() - t0 >= ms, ms + 60000, Math.min(ms, 100)); };
  const main = () => document.querySelector(D.SEL.main) || document.body;

  // expect: list of acceptable session ids (canonical + aliases), supplied by the service worker.
  function requireSession(expect) {
    const id = D.identity(document);
    if (!id.verified) fail(E.IDENTITY, "open page's session identity could not be verified", { identity: id });
    if (expect && expect.length && !expect.includes(id.sessionId)) fail(E.IDENTITY, `open session is ${id.sessionId}, expected ${expect[0]}`, { identity: id });
    return id;
  }
  function requireWritable() {
    const doc = D.doctor(document);
    if (doc.mode !== "read-write") fail(E.DEGRADED, "bridge is read-only: a critical element is missing", { checks: doc.checks });
  }
  function requireControl(scope, bundle, what) {
    const r = D.resolve(scope, bundle);
    if (!r.el) fail(E.NOT_FOUND, `${what} control not found`);
    if (r.count !== 1 || r.confidence < D.ACTION_MIN_CONF) fail(E.LOW_CONF, `${what} control could not be identified with sufficient confidence`, { count: r.count, confidence: r.confidence, via: r.via });
    return r;
  }
  const lastIndex = () => { const m = D.readMessages(document); return m.length ? m[m.length - 1].index : 0; };

  // The extension keeps one background tab per site for itself (see service worker). It is marked through
  // window.name, which survives navigation and browser restarts. Only that tab publishes the session list and
  // expands sidebar projects, so the user's own tabs are never touched in the background.
  const OWNED = "cc-bridge";
  const owned = () => window.name === OWNED;
  const sessionFromHref = (href) => { const m = String(href || "").match(/^\/(chat|cowork)\/([0-9a-f-]{36}|cse_[A-Za-z0-9]+)/); return m ? { kind: m[1], sessionId: m[1] === "cowork" ? m[2] : `chat:${m[2]}` } : null; };

  const handlers = {
    ping: () => ({ identity: D.identity(document) }),
    mark: () => { window.name = OWNED; listSig = null; listTickSoon(); return { owned: true }; },
    // Signed in = the app shell (sidebar) rendered; the login page has none.
    health: async () => {
      const shell = await waitFor(() => document.querySelector(D.SEL.sidebarRow) || document.querySelector("nav"), 8000);
      return { owned: owned(), signedIn: !!shell && !/^\/(login|logout)/.test(location.pathname), path: location.pathname };
    },
    // On /projects: every project (id + name), not just the ones pinned in the sidebar.
    projectsIndex: async () => {
      if (location.pathname !== "/projects") fail(E.STATE, "not on /projects");
      const links = () => [...(document.querySelector("main") || document.body).querySelectorAll('a[href^="/project/"]')];
      await waitFor(() => links().length > 0, 10000);
      await settle(400);
      const seen = new Set();
      return links().map((a) => ({ id: a.getAttribute("href").split("/")[2], title: D.norm(a.textContent).slice(0, 80) })).filter((p) => /^[0-9a-f-]{36}$/.test(p.id) && !seen.has(p.id) && seen.add(p.id));
    },
    // On /project/<id>: the project's sessions, newest first; "Show more" is pressed up to maxMore times.
    projectPage: async ({ maxMore = 3 } = {}) => {
      const m = location.pathname.match(/^\/project\/([0-9a-f-]{36})/); if (!m) fail(E.STATE, "not on a project page");
      const root = () => document.querySelector("main") || document.body;
      const links = () => [...root().querySelectorAll('a[href^="/chat/"], a[href^="/cowork/"]')];
      await waitFor(() => links().length > 0 || /no (chats|conversations|tasks)/i.test(root().innerText), 10000);
      await settle(300);
      for (let i = 0; i < maxMore; i++) {
        const more = [...root().querySelectorAll("button")].find((b) => /^show more$/i.test(D.norm(b.textContent)));
        if (!more) break;
        const n = links().length; more.click();
        if (!(await waitFor(() => links().length > n, 5000))) break;
      }
      const project = D.norm(document.title.replace(/\s+-\s+Claude$/, "")) || m[1];
      const seen = new Set();
      return { projectId: m[1], project, sessions: links().map((a) => {
        const s = sessionFromHref(a.getAttribute("href")); if (!s || seen.has(s.sessionId)) return null; seen.add(s.sessionId);
        // Project cards are an empty full-size link over the card; the name is the link's aria-label.
        const title = D.norm(a.getAttribute("aria-label") || a.textContent || (a.parentElement && a.parentElement.innerText.split("\n")[0]) || "").slice(0, 120);
        const t = a.parentElement && a.parentElement.querySelector("time[datetime], [datetime]");   // "1 minute ago" → exact time
        const updatedAt = t && !isNaN(Date.parse(t.getAttribute("datetime"))) ? new Date(t.getAttribute("datetime")).toISOString() : undefined;
        return { ...s, title, url: new URL(a.getAttribute("href"), location.origin).href, group: `Project: ${project}`, project, current: false, status: "unknown", updatedAt };
      }).filter(Boolean) };
    },
    identity: () => {
      const id = D.identity(document);
      // ready = session UI present AND the DOM has been quiet for 600ms (cards hydrate after the transcript)
      const ready = !!(D.resolve(document, "composer").el || document.querySelector(D.SEL.message)) && (Date.now() - lastMutationAt > 600 || (id.sessionId === sessionSinceId && Date.now() - sessionSince > 2500));
      return { ...id, ready, owned: owned() };
    },
    doctor: () => D.doctor(document),

    // Cowork step groups ("Used 9 tools, ran 3 commands"): read-only, on demand. Expands what it needs, reads, and
    // restores the collapsed view (view state only; nothing is sent). Steps are identified by data-step-key.
    steps: ({ turnKey, group = 0 }) => withGroup(turnKey, group, async ({ label, region }) => ({
      label,
      steps: topSteps(region).map((el) => ({ key: el.getAttribute("data-step-key"), text: D.norm(el.innerText).slice(0, 300), state: el.getAttribute("data-state"), openable: !!toggleOf(el) })).filter((x) => x.text),
    })),
    stepOpen: ({ turnKey, group = 0, stepKey }) => withGroup(turnKey, group, async ({ label, region }) => {
      const el = topSteps(region).find((e) => e.getAttribute("data-step-key") === stepKey) || region.querySelector(`[data-step-key="${CSS.escape(stepKey || "")}"]`);
      if (!el) fail(E.NOT_FOUND, "step not found (it may have been re-rendered)");
      const t = toggleOf(el); const was = t && t.getAttribute("aria-expanded") === "true";
      const lines = () => region.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
      const before = lines();
      if (t && !was) { t.click(); await waitFor(() => t.getAttribute("aria-expanded") === "true" && lines().length > before.length, 3000, 100).catch(() => null); await settle(400); }
      // details render next to the step, not inside it: take the lines that appeared on opening
      const after = lines(); const counts = new Map(); before.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
      const added = after.filter((x) => { const n = counts.get(x) || 0; if (n) { counts.set(x, n - 1); return false; } return true; });
      const ctl = t && t.getAttribute("aria-controls"); const panel = ctl && document.getElementById(ctl);
      const text = (panel ? panel.innerText : added.join("\n")).trim().slice(0, 6000);
      if (t && !was) { t.click(); await settle(150); }
      return { group: label, stepKey, step: D.norm(el.innerText).slice(0, 200), text, via: panel ? "aria-controls" : "diff", toggle: t ? t.tagName : null };
    }),

    list: () => { refreshProjectsSoon(); return { sessions: currentList(), source: "sidebar (rendered rows + active pinned projects, cached)" }; },
    // Prefer SPA navigation through the sidebar link whose href IS the id (never by title).
    navigate: async ({ path }) => {
      if (!/^\/(cowork\/cse_[A-Za-z0-9]+|chat\/[0-9a-f-]{36})$/.test(path)) fail(E.STATE, `refusing to navigate to ${path}`);
      let link = document.querySelector(`[data-row-key] a[href="${path}"]`) || document.querySelector(`nav a[href="${path}"], aside a[href="${path}"]`);
      let reCollapse = null;
      if (!link) {   // inside a collapsed (pinned) project? try the known project first, then each collapsed project
        const known = [...projCache.entries()].find(([, c]) => c.sessions.some((x) => x.url && new URL(x.url).pathname === path));
        const toggles = [...document.querySelectorAll('[aria-label^="Toggle sessions for"]')]
          .sort((a, b) => (known && a.getAttribute("aria-label").includes(known[0]) ? -1 : 0) - (known && b.getAttribute("aria-label").includes(known[0]) ? -1 : 0));
        for (const toggle of toggles) {
          const wasOpen = toggle.getAttribute("aria-expanded") === "true";
          if (!wasOpen) toggle.click();
          link = await waitFor(() => document.querySelector(`a[href="${path}"]`), wasOpen ? 300 : 2500, 100);
          if (link) { if (!wasOpen) reCollapse = toggle; break; }
          if (!wasOpen && toggle.getAttribute("aria-expanded") === "true") toggle.click();   // not here: collapse again
        }
      }
      if (link) {
        link.click();
        if (reCollapse) ui(2, async () => { await waitFor(() => location.pathname === path, 4000, 100); await settle(600); if (reCollapse.getAttribute("aria-expanded") === "true") reCollapse.click(); }).catch(() => {});
        return { method: "spa" };
      }
      setTimeout(() => location.assign(path), 30);
      return { method: "full" };
    },

    read: async ({ expect, limit = 20 }) => {
      const id = requireSession(expect);
      // right after opening, the conversation may not be rendered yet: wait (mutation-driven) instead of reading nothing
      if (!D.readMessages(document).length) await waitFor(() => D.readMessages(document).length > 0, 6000, 150);
      const msgs = D.readMessages(document);
      return { sessionId: id.sessionId, identity: id, total: msgs.length ? msgs[msgs.length - 1].total : 0, rendered: msgs.length, messages: msgs.slice(-limit) };
    },
    status: ({ expect }) => {
      const id = requireSession(expect);
      return { sessionId: id.sessionId, identity: id, environment: (D.resolve(main(), "environment").el && D.accName(D.resolve(main(), "environment").el)) || null, ...D.status(document) };
    },

    send: async ({ expect, message, force }) => {
      const id = requireSession(expect);
      // A pending question whose options match the text exactly once is answered by clicking that option.
      const pending = D.status(document);
      if (pending.status === "waiting_for_input" && optionMatches(message).length === 1) return { ...(await handlers.answer({ expect, option: message })), via: "question-option" };
      requireWritable();
      const comp = requireControl(document, "composer", "composer").el;
      if (D.norm(comp.textContent) && !force) fail(E.STATE, "composer already contains a draft; refusing to overwrite (pass force)");
      const before = lastIndex();
      comp.focus();
      if (force) document.execCommand("selectAll", false);
      document.execCommand("insertText", false, message);
      if (!(await waitFor(() => D.norm(comp.textContent).includes(D.norm(message).slice(0, 40)), 2000))) fail(E.VERIFY, "text did not land in composer");
      const sendCtl = await waitFor(() => { const r = D.resolve(document, "send"); return r.el && !r.el.disabled && r.confidence >= D.ACTION_MIN_CONF ? r : null; }, 3000);
      if (!sendCtl) fail(E.LOW_CONF, "send control not found/enabled with sufficient confidence");
      sendCtl.el.click();
      const want = D.norm(message).slice(0, 60);
      const landed = await waitFor(() => D.readMessages(document).find((m) => m.index > before && m.role === "user" && D.norm(m.text).includes(want)), 10000);
      const after = D.identity(document);
      if (after.sessionId !== id.sessionId) fail(E.VERIFY, `session changed after send (${id.sessionId} → ${after.sessionId})`);
      if (!landed) fail(E.VERIFY, "sent message did not appear in transcript within 10s");
      return { sessionId: id.sessionId, messageIndex: landed.index, status: D.status(document).status };
    },

    answer: async ({ expect, option }) => {
      const id = requireSession(expect);
      const st = D.status(document);
      if (st.status !== "waiting_for_input") fail(E.STATE, `session is ${st.status}, not waiting_for_input`);
      requireControl(main(), "questionGroup", "question card");
      const opts = optionMatches(option);
      if (opts.length !== 1) fail(E.LOW_CONF, `option "${option}" matched ${opts.length} controls`, { options: st.question.options });
      opts[0].click();
      const moved = await waitFor(() => D.status(document).status !== "waiting_for_input", 10000);
      return { sessionId: id.sessionId, answered: D.accName(opts[0]), status: D.status(document).status, verified: !!moved };
    },

    approve: (p) => decide(p, "approve"),
    deny: (p) => decide(p, "deny"),

    stop: async ({ expect }) => {
      const id = requireSession(expect);
      const st = D.status(document);
      if (st.status !== "working") fail(E.STATE, `session is ${st.status}, not working`);
      requireControl(main(), "stop", "stop").el.click();
      const settled = await waitFor(() => { const s = D.status(document).status; return s !== "working" ? s : null; }, 15000, 200);
      if (!settled) fail(E.VERIFY, "still working 15s after stop");
      return { sessionId: id.sessionId, status: settled };
    },

    snapshot: () => ({ html: sanitizedMain(), snapshot: D.snapshot(document) }),
  };

  function optionMatches(option) {
    const q = D.resolve(main(), "questionGroup").el;
    if (!q) return [];
    const want = D.norm(option).toLowerCase();
    return D.questionOptions(q).filter((b) => {
      const n = D.accName(b).replace(/^\d+\s+/, "").toLowerCase();
      return n === want || n.startsWith(want + " ");
    });
  }

  async function decide({ expect }, which) {
    const id = requireSession(expect);
    const st = D.status(document);
    if (st.status !== "approval_required") fail(E.STATE, `session is ${st.status}, not approval_required`);
    const group = requireControl(main(), "permissionGroup", "permission card").el;
    const ctl = requireControl(group, which, which).el;
    const label = D.accName(ctl);
    ctl.click();
    const gone = await waitFor(() => !group.isConnected || D.status(document).status !== "approval_required", 10000, 200);
    return {
      sessionId: id.sessionId, clicked: label, status: D.status(document).status, verified: !!gone,
      note: gone ? undefined : "card still rendered after 10s; claude.ai sometimes leaves a resolved card visible until reload. Check transcript/status before retrying.",
    };
  }

  // ---- sanitized fixture capture (dev aid): structure + semantic attrs, private text replaced ----
  const KEEP_ATTR = /^(role|aria-label|aria-current|aria-live|aria-hidden|aria-disabled|aria-expanded|aria-setsize|aria-posinset|data-testid|data-cds|data-is-streaming|data-row-key|data-turn-key|contenteditable|href|disabled|type)$/;
  const KEEP_TEXT = /^(Allow once|Always allow|Decline|Deny|Skip|Stop response|Send message|You said:|Claude responded:|Claude[’']s response was interrupted\.?|Edit prompt|Try again|Esc|Enter|Command|⌘|⏎|\d+|Message \d+ of \d+)$/;
  function sanitizedMain() {
    const clone = main().cloneNode(true);
    clone.querySelectorAll("svg, script, style, img, picture, video").forEach((e) => e.remove());
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = walker.currentNode; n; n = walker.nextNode()) {
      if (n.nodeType === 3) { texts.push(n); continue; }
      for (const a of [...n.attributes]) {
        if (!KEEP_ATTR.test(a.name)) n.removeAttribute(a.name);
        else if (a.name === "aria-label") n.setAttribute("aria-label", sanitizeLabel(a.value));
        else if (a.name === "href") n.setAttribute("href", a.value.replace(/cse_[A-Za-z0-9]+/, "cse_FIXTURE").replace(/[0-9a-f-]{36}/, "00000000-0000-4000-8000-000000000000"));
        else if (a.name === "data-row-key" || a.name === "data-turn-key") n.setAttribute(a.name, a.value.replace(/cse_[A-Za-z0-9]+/, "cse_FIXTURE").replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, "00000000-0000-4000-8000-000000000000"));
      }
    }
    for (const t of texts) { const v = t.nodeValue.trim(); if (v && !KEEP_TEXT.test(v)) t.nodeValue = v.replace(/[^\s]/g, "x").slice(0, 40); }
    return clone.outerHTML;
  }
  function sanitizeLabel(v) {
    if (/^Message \d+ of \d+$|^(Send message|Stop response|Skip|Allow once|Decline|Write your prompt to Claude)$/.test(v)) return v;
    const m = v.match(/^(Permission request|Show message actions for You said|Show message actions for Claude responded|More options for)(:)?/);
    if (m) return m[0] + " PLACEHOLDER";
    if (/, (Connected|Disconnected|Offline)$/.test(v)) return v.replace(/^.*(, \w+)$/, "Device$1");
    if (/\?$/.test(v)) return "Placeholder question?";
    return "PLACEHOLDER";
  }

  // ---- pinned projects: read the sessions of active (Running / Awaiting input / Unread) collapsed projects ----
  const projCache = new Map(); // project title -> { status, at, sessions }
  function cachedProjectSessions() { return [...projCache.values()].flatMap((c) => c.sessions); }
  function currentList() {
    const top = D.listSidebarSessions(document); const seen = new Set(top.map((x) => x.sessionId));
    return [...top, ...cachedProjectSessions().filter((x) => !seen.has(x.sessionId))];
  }
  let projRefreshing = false;
  function refreshProjectsSoon() {
    if (projRefreshing || !owned()) return; projRefreshing = true;
    ui(2, projectSessions).catch(() => {}).finally(() => { projRefreshing = false; listTickSoon(); });
  }
  async function projectSessions() {
    const out = [];
    for (const row of [...document.querySelectorAll('[data-row-key^="project:"]')]) {
      const labels = [...row.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));
      const status = labels.includes("Running") ? "working" : labels.includes("Awaiting input") ? "waiting_for_input" : labels.includes("Unread response") ? "complete" : null;
      const toggle = row.querySelector('[aria-label^="Toggle sessions for"]');
      const title = D.norm((labels.find((l) => l.startsWith("Toggle sessions for ")) || "").replace("Toggle sessions for ", "")) || D.norm(row.textContent).slice(0, 60);
      if (!status || !toggle) { projCache.delete(title); continue; }
      const c = projCache.get(title);
      if (c && c.status === status && Date.now() - c.at < 60000) { out.push(...c.sessions); continue; }
      const expanded = () => (toggle.getAttribute("aria-expanded") ?? row.getAttribute("aria-expanded")) === "true";
      // A project's sessions render as plain links inside the project's own block (not as sidebar rows).
      const links = () => [...row.querySelectorAll('a[href^="/chat/"], a[href^="/cowork/"]')];
      const was = expanded();
      if (!was) { toggle.click(); await waitFor(() => links().length > 0, 3000, 100); await settle(250); }
      const ls = links();
      const found = ls.map((a) => {
        const href = a.getAttribute("href"); const m = href.match(/^\/(chat|cowork)\/([0-9a-f-]{36}|cse_[A-Za-z0-9]+)/); if (!m) return null;
        const box = a.closest("li, [role=listitem], div") || a;
        const ll = [...box.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));
        const st = ll.includes("Running") ? "working" : ll.includes("Awaiting input") ? "waiting_for_input" : ll.includes("Unread response") ? "complete" : ls.length === 1 ? status : "unknown";
        return { sessionId: m[1] === "cowork" ? m[2] : `chat:${m[2]}`, kind: m[1], title: D.norm(a.textContent), url: new URL(href, location.origin).href, group: `Project: ${title}`, project: title, current: false, status: st };
      }).filter(Boolean);
      if (!was && expanded()) toggle.click();   // restore the collapsed view
      projCache.set(title, { status, at: Date.now(), sessions: found }); out.push(...found);
    }
    return out;
  }

  // ---- Cowork step-group helpers ----
  const toggleOf = (el) => (el.matches("[aria-expanded]") ? el : el.querySelector(":scope [aria-expanded]") || null);
  const topSteps = (region) => [...region.querySelectorAll('[data-cds="TurnStatusStep"]')].filter((e) => !e.parentElement.closest('[data-cds="TurnStatusStep"]') || !region.contains(e.parentElement.closest('[data-cds="TurnStatusStep"]')));
  async function withGroup(turnKey, group, fn) {
    const msgs = [...document.querySelectorAll(D.SEL.assistantMessage)];
    const asst = turnKey ? msgs.find((m) => m.getAttribute("data-turn-key") === turnKey) : [...msgs].reverse().find((m) => m.querySelector(D.SEL.turnStatus));
    if (!asst) fail(E.NOT_FOUND, "that reply is not rendered in the bridge tab right now");
    const groups = [...asst.querySelectorAll(D.SEL.turnStatus)]; const g = groups[group];
    if (!g) fail(E.NOT_FOUND, `step group ${group} not found (${groups.length} groups)`);
    const label = D.norm((g.querySelector('[role="status"]') || g).textContent);
    const toggle = g.matches("[aria-expanded]") ? g : g.querySelector("[aria-expanded]"); // only the group's OWN control
    if (!toggle) fail(E.NOT_FOUND, "this is a single step, not an expandable group");
    const was = toggle.getAttribute("aria-expanded") === "true"; const before = asst.innerText.length;
    if (!was) { toggle.click(); await waitFor(() => toggle.getAttribute("aria-expanded") === "true" || asst.innerText.length > before + 20, 3000, 100).catch(() => null); await settle(400); }
    try { return await fn({ label, region: g.parentElement, asst }); }
    finally { if (!was && toggle.getAttribute("aria-expanded") === "true") toggle.click(); }
  }

  // ---- one UI lane per tab: page-changing work never overlaps; user actions (0) before steps (1) before background (2)
  const uiQ = []; let uiBusy = false, uiSeq = 0;
  function ui(prio, fn) { return new Promise((res, rej) => { uiQ.push({ prio, fn, res, rej, n: uiSeq++ }); uiQ.sort((a, b) => a.prio - b.prio || a.n - b.n); pumpUi(); }); }
  async function pumpUi() { if (uiBusy || !uiQ.length) return; const j = uiQ.shift(); uiBusy = true; try { j.res(await j.fn()); } catch (e) { j.rej(e); } finally { uiBusy = false; pumpUi(); } }
  const LANE = { send: 0, answer: 0, approve: 0, deny: 0, stop: 0, steps: 1, stepOpen: 1 };

  // ---- session list stream: push "list changed" events instead of being polled ----
  let listSig = null, listTimer = null;
  function listTick() {
    listTimer = null; if (!owned()) return;
    let rows; try { rows = currentList(); } catch { return; }
    const sig = JSON.stringify(rows.map((r) => [r.sessionId, r.status, r.title, r.project || ""]));
    if (sig !== listSig) { listSig = sig; emit("session.listChanged", { sessionId: "_list", sessions: rows, sig: hash(sig) }); }
    // a pinned project's status label changed (or its cache is old) → re-read it in the background
    for (const row of document.querySelectorAll('[data-row-key^="project:"]')) {
      const ls = [...row.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));
      const st = ls.includes("Running") ? "working" : ls.includes("Awaiting input") ? "waiting_for_input" : ls.includes("Unread response") ? "complete" : null;
      const title = D.norm((ls.find((l) => l.startsWith("Toggle sessions for ")) || "").replace("Toggle sessions for ", ""));
      const c = projCache.get(title);
      if ((st && (!c || c.status !== st || Date.now() - c.at > 60000)) || (!st && c)) { refreshProjectsSoon(); break; }
    }
  }
  // Driven by DOM mutations (delivered promptly in hidden tabs, unlike timers): tick at most once per 900 ms,
  // with a trailing timer only as a fallback for the last change.
  let lastTick = 0;
  function listTickSoon() { const now = Date.now(); clearTimeout(listTimer); if (now - lastTick >= 900) { lastTick = now; listTick(); } else listTimer = setTimeout(() => { lastTick = Date.now(); listTick(); }, 900); }
  const hash = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; };
  new MutationObserver(listTickSoon).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "data-row-key", "href"] });
  setTimeout(listTick, 1500);

  // ---- RPC from service worker ----
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.kind !== "rpc") return;
    const h = handlers[msg.method];
    Promise.resolve()
      .then(() => { if (!h) fail(E.UNKNOWN_METHOD, msg.method); return msg.method in LANE ? ui(LANE[msg.method], () => h(msg.params || {})) : h(msg.params || {}); })
      .then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: { code: e.code || "ERROR", message: e.message, details: e.details } }));
    return true;
  });

  // ---- events: MutationObserver on <main>, coalesced ----
  // Trailing debounce 250ms, max wait 1000ms; streaming text emits at most one messageUpdated per 1.5s.
  // (Hidden tabs clamp timers to ~1s, so events arrive within ~1–2s there.)
  let prev = null, timer = null, firstDirty = 0, lastStreamEmit = 0, lastMutationAt = Date.now(), sessionSince = Date.now(), sessionSinceId = null;
  // Messages are keyed by identity, not by "Message N of M" index (indices shift while a turn is built):
  // assistant → data-turn-key; user → normalized text + occurrence number. Role-less placeholders are skipped.
  let seen = new Map(); // key -> text length
  function keyed(msgs) {
    const counts = {};
    return msgs.filter((m) => m.role !== "unknown").map((m) => {
      if (m.role === "assistant" && m.turnKey) return { key: "a:" + m.turnKey, m };
      const t = D.norm(m.text).slice(0, 300);
      counts[t] = (counts[t] || 0) + 1;
      return { key: `u:${counts[t]}:${t}`, m };
    });
  }
  const emit = (event, data) => chrome.runtime.sendMessage({ kind: "event", event, ...data, at: new Date().toISOString() }).catch(() => {});
  function evaluate() {
    timer = null; firstDirty = 0;
    let s, msgs;
    try { s = D.snapshot(document); msgs = keyed(D.readMessages(document)); } catch (e) { return; }
    const sid = s.identity.sessionId;
    if (sessionSinceId !== sid) { sessionSinceId = sid; sessionSince = Date.now(); }
    if (!prev || prev.identity.sessionId !== sid) {
      emit("session.changed", { sessionId: sid, identity: s.identity, status: s.status });
      seen = new Map(msgs.map(({ key, m }) => [key, m.text.length])); // don't replay history
      prev = s; return;
    }
    const now = Date.now();
    for (const { key, m } of msgs) {
      if (!seen.has(key)) {
        seen.set(key, m.text.length);
        emit("session.messageAdded", { sessionId: sid, key, index: m.index, role: m.role, text: m.text.slice(0, 2000), tools: m.tools, streaming: m.streaming });
      } else if (m.role === "assistant" && seen.get(key) !== m.text.length && (now - lastStreamEmit > 1500 || !m.streaming)) {
        // coalesced streaming delta: at most one update per 1.5s, plus a final one when streaming ends
        const prevLen = seen.get(key);
        seen.set(key, m.text.length);
        lastStreamEmit = now;
        emit("session.messageUpdated", { sessionId: sid, key, index: m.index, textLength: m.text.length, delta: m.text.slice(prevLen, prevLen + 2000), streaming: m.streaming, tools: m.tools });
      }
    }
    if (s.status !== prev.status) {
      emit("session.statusChanged", { sessionId: sid, from: prev.status, status: s.status });
      if (s.status === "approval_required") emit("session.approvalRequested", { sessionId: sid, approval: s.approval });
      if (s.status === "waiting_for_input") emit("session.questionRequested", { sessionId: sid, question: s.question });
      if (s.status === "interrupted") emit("session.interrupted", { sessionId: sid });
      if (prev.status === "working" && s.status === "idle") {
        const last = msgs.filter(({ m }) => m.role === "assistant").pop();
        if (last) emit("session.messageFinal", { sessionId: sid, key: last.key, text: last.m.text.slice(0, 8000) });
        emit("session.completed", { sessionId: sid });
      }
    }
    prev = s;
  }
  function schedule() {
    const now = Date.now();
    lastMutationAt = now;
    if (!firstDirty) firstDirty = now;
    clearTimeout(timer);
    timer = setTimeout(evaluate, now - firstDirty > 1000 ? 0 : 250);
  }
  let observed = null;
  function attach() {
    const m = document.querySelector(D.SEL.main);
    if (!m || m === observed) return;
    observed = m;
    new MutationObserver(schedule).observe(m, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-is-streaming", "aria-label", "aria-disabled", "disabled"] });
    schedule();
  }
  // <main> can be replaced on SPA navigation; a cheap observer on <body> children re-attaches.
  new MutationObserver(() => { attach(); if (prev && D.identity(document).sessionId !== prev.identity.sessionId) schedule(); }).observe(document.body, { childList: true });
  attach();
  window.addEventListener("popstate", schedule);
  chrome.runtime.sendMessage({ kind: "hello", identity: D.identity(document), url: location.href }).catch(() => {});
})();
