// Cowork Bridge: the ONLY file that knows claude.ai's DOM.
// Classic script (content scripts can't be ES modules). Exposes globalThis.CoworkDom.
// Also loaded by tests/run-fixtures.mjs into a jsdom window.
//
// Selector strategy, highest confidence first:
//   100 stable data-testid / data-row-key / data-cds
//    90 role + exact accessible name
//    80 role + regex accessible name (or scoped inside a high-confidence region)
//    65 stable visible text
//    40 structural heuristic
// Coordinates are never used. Consequential actions require >= 80 AND exactly one match.
// textContent is used (not innerText): it is layout-independent, so it works in background tabs and jsdom.
(function (root) {
  "use strict";

  const CONF = { TESTID: 100, ROLE_EXACT: 90, ROLE_REGEX: 80, TEXT: 65, STRUCT: 40 };
  const ACTION_MIN_CONF = 80;

  // ---- selector bundles (evidence: live claude.ai DOM, 2026-10-01) ----
  const SEL = {
    main: "main",
    // Sidebar rows: data-row-key="cowork:cse_…" | "chat:<uuid>" | "scheduled-task:…" | "label:day-0" | "project:…"
    sidebarRow: "[data-row-key]",
    currentRowLink: '[data-row-key] a[aria-current="page"]',
    message: '[role="article"][aria-label^="Message "]', // aria-label "Message N of M" (virtualized list)
    assistantMessage: '[data-testid="assistant-message"]', // has data-turn-key, data-is-streaming
    assistantProse: '[data-cds="Prose"]',
    turnStatus: '[data-cds="TurnStatus"]', // tool/progress line ("Ran a command on your computer")
    userMessage: '[data-testid="user-message"]',
    streaming: '[data-testid="assistant-message"][data-is-streaming="true"]',
    failedSend: '[data-testid="failed-send-status-region"]',
    messageActions: '[data-testid="message-actions"]', // rendered once a turn is complete
  };

  const BUNDLES = {
    composer: [
      { css: '[data-testid="chat-input"][contenteditable="true"]', conf: CONF.TESTID },
      { css: '[contenteditable="true"][aria-label="Write your prompt to Claude"]', conf: CONF.ROLE_EXACT },
    ],
    send: [{ role: "button", name: "Send message", conf: CONF.ROLE_EXACT }],
    stop: [{ role: "button", name: "Stop response", conf: CONF.ROLE_EXACT }],
    permissionGroup: [
      { css: '[data-testid="hub-approval-card"]', conf: CONF.TESTID }, // inside role=group "Permission request: …"
      { css: '[role="group"][aria-label^="Permission request"]', conf: CONF.ROLE_REGEX },
    ],
    approve: [{ role: "button", name: /^Allow once\b/, conf: CONF.ROLE_REGEX }],
    deny: [{ role: "button", name: /^(Decline|Deny)\b/, conf: CONF.ROLE_REGEX }],
    // Question card: a group whose accessible name is the question, containing a "Skip" button.
    questionGroup: [
      { css: '[data-cds="AskUserQuestion"][role="group"]', conf: CONF.TESTID },
      { css: '[data-testid="hub-ask-user-question-card"] [role="group"]', conf: CONF.TESTID },
      { css: '[role="group"][aria-label$="?"]', conf: CONF.ROLE_REGEX, mustContain: { role: "button", name: "Skip" } },
    ],
    environment: [{ role: "button", name: /, (Connected|Disconnected|Offline)$/, conf: CONF.ROLE_REGEX }],
  };

  const TEXT = {
    interrupted: /Claude[’']s response was interrupted/,
    failed: /(Something went wrong|failed to respond|An error occurred)/i,
  };

  // ---- helpers ----
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Text with element boundaries as spaces, skipping aria-hidden subtrees (keyboard hints, icons).
  function textOf(el) {
    const parts = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) parts.push(c.nodeValue);
        else if (c.nodeType === 1 && c.getAttribute("aria-hidden") !== "true" && !/^(SVG|STYLE|SCRIPT)$/i.test(c.nodeName)) walk(c);
      }
    })(el);
    return norm(parts.join(" "));
  }
  function accName(el) {
    const label = el.getAttribute("aria-label");
    if (label) return norm(label);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)).filter(Boolean).map(textOf).join(" ");
      if (norm(t)) return norm(t);
    }
    return textOf(el);
  }
  function byRole(scope, role) {
    if (role === "button") return [...scope.querySelectorAll('button, [role="button"]')];
    return [...scope.querySelectorAll(`[role="${role}"]`)];
  }
  function nameMatches(name, want) { return want instanceof RegExp ? want.test(name) : name === want; }
  function candidateMatches(scope, c) {
    let els = c.css ? [...scope.querySelectorAll(c.css)] : byRole(scope, c.role).filter((e) => nameMatches(accName(e), c.name));
    if (c.mustContain) els = els.filter((e) => candidateMatches(e, c.mustContain).length > 0);
    return els.filter((e) => !e.closest("[inert]"));
  }
  // Returns {el, confidence, count, via}. Ambiguity (count>1) drops confidence to STRUCT.
  function resolve(scope, bundleName) {
    for (const c of BUNDLES[bundleName]) {
      const els = candidateMatches(scope, c);
      if (els.length) {
        return { el: els[els.length - 1], count: els.length, confidence: els.length === 1 ? c.conf : CONF.STRUCT, via: c.css || `${c.role}:${c.name}` };
      }
    }
    return { el: null, count: 0, confidence: 0, via: null };
  }

  // ---- identity ----
  function identity(doc) {
    const path = doc.location.pathname;
    const chatId = (path.match(/^\/chat\/([0-9a-f-]{36})/) || [])[1] || null;
    const link = doc.querySelector(SEL.currentRowLink);
    const rowKey = link ? link.closest("[data-row-key]").getAttribute("data-row-key") : null;
    let sessionId = null, kind = null;
    if (rowKey) {
      const i = rowKey.indexOf(":");
      kind = rowKey.slice(0, i);
      const v = rowKey.slice(i + 1);
      sessionId = kind === "cowork" ? v : `${kind}:${v}`;
    }
    // A chat row must agree with the URL; anything else is treated as unverified.
    const consistent = !(kind === "chat" && chatId && rowKey !== `chat:${chatId}`);
    const title = norm(doc.title.replace(/ - Claude$/, ""));
    if (!sessionId) {
      // No highlighted sidebar row (e.g. a session inside a collapsed pinned project): verify from the page itself —
      // the URL carries the id, the title names a real conversation, and the conversation is rendered.
      const cse = (path.match(/^\/cowork\/(cse_[A-Za-z0-9]+)/) || [])[1];
      const rendered = !!(doc.querySelector(SEL.message) || doc.querySelector('[data-testid="chat-input"]'));
      if ((chatId || cse) && title && title !== "Claude" && rendered)
        return { path, chatId, rowKey: null, sessionId: cse || `chat:${chatId}`, kind: cse ? "cowork" : "chat", verified: true, verification: "url", title };
    }
    return { path, chatId, rowKey, sessionId: consistent ? sessionId : null, kind, verified: !!sessionId && consistent, title };
  }

  // ---- discovery (sidebar only; it is virtualized, so this lists what is rendered) ----
  // claude.ai marks rows with status labels: "Running" (breathing dot), "Awaiting input", "Unread response".
  function rowStatus(row) {
    const labels = [...row.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));
    if (labels.includes("Running")) return "working";
    if (labels.includes("Awaiting input")) return "waiting_for_input";
    if (labels.includes("Unread response")) return "complete";
    return "unknown";
  }
  function listSidebarSessions(doc) {
    const out = [];
    let group = null;
    for (const row of doc.querySelectorAll(SEL.sidebarRow)) {
      const key = row.getAttribute("data-row-key");
      const [kind] = key.split(":");
      if (kind === "label") { group = textOf(row).replace(/[\uE000-\uF8FF]/g, "").trim(); continue; } // drop icon-font glyphs
      if (kind !== "cowork" && kind !== "chat") continue;
      const a = row.querySelector("a[href]");
      const v = key.slice(kind.length + 1);
      out.push({
        sessionId: kind === "cowork" ? v : `chat:${v}`,
        kind,
        title: a ? norm(a.textContent) : norm(row.textContent),
        url: a ? new URL(a.getAttribute("href"), doc.location.origin).href : null,
        group,
        current: !!(a && a.getAttribute("aria-current") === "page"),
        status: rowStatus(row),
      });
    }
    return out;
  }

  // ---- transcript ----
  const groupToggle = (t) => (t.matches("[aria-expanded]") ? t : t.querySelector("[aria-expanded]"));
  function readMessages(doc) {
    const labeled = [...doc.querySelectorAll(SEL.message)];
    const out = labeled.map((art) => {
      const [, n, total] = (art.getAttribute("aria-label").match(/Message (\d+) of (\d+)/) || []);
      const asst = art.querySelector(SEL.assistantMessage);
      if (asst) {
        const prose = [...asst.querySelectorAll(SEL.assistantProse)].map((p) => p.textContent.trim()).filter(Boolean).join("\n\n");
        const st = [...asst.querySelectorAll(SEL.turnStatus)].map((t) => ({ text: norm((t.querySelector('[role="status"]') || t).textContent), group: !!groupToggle(t) })).filter((x) => x.text);
        return { index: +n, total: +total, role: "assistant", turnKey: asst.getAttribute("data-turn-key"), streaming: asst.getAttribute("data-is-streaming") === "true", text: prose, tools: st.map((x) => x.text), toolGroups: st.map((x) => x.group), interrupted: TEXT.interrupted.test(art.textContent) };
      }
      const user = art.querySelector(SEL.userMessage);
      if (user) return { index: +n, total: +total, role: "user", text: user.textContent.trim() };
      return { index: +n, total: +total, role: "unknown", text: norm(art.textContent).slice(0, 500) };
    });
    // A reply still being built may not carry the "Message N of M" label yet: include trailing unlabeled ones.
    const lastTotal = out.length ? out[out.length - 1].total : 0;
    const orphans = [...doc.querySelectorAll(SEL.assistantMessage)].filter((a) => !labeled.some((art) => art.contains(a)));
    orphans.forEach((asst, i) => {
      const prose = [...asst.querySelectorAll(SEL.assistantProse)].map((p) => p.textContent.trim()).filter(Boolean).join("\n\n");
      const st = [...asst.querySelectorAll(SEL.turnStatus)].map((t) => ({ text: norm((t.querySelector('[role="status"]') || t).textContent), group: !!groupToggle(t) })).filter((x) => x.text);
      out.push({ index: lastTotal + i + 1, total: lastTotal + orphans.length, role: "assistant", turnKey: asst.getAttribute("data-turn-key"), streaming: asst.getAttribute("data-is-streaming") === "true", text: prose, tools: st.map((x) => x.text), toolGroups: st.map((x) => x.group), inProgress: true });
    });
    return out;
  }

  // ---- status (deterministic precedence) ----
  // A permission/question card is LIVE only while the latest turn is an open assistant turn
  // (no message-actions bar yet) and nothing is running. claude.ai can leave a resolved card rendered
  // after the turn completes; such a card is reported as staleCard, never as pending.
  function turnState(doc) {
    const arts = doc.querySelectorAll(SEL.message);
    const last = arts[arts.length - 1];
    const asst = last && last.querySelector(SEL.assistantMessage);
    return { last, open: !!asst && !last.querySelector(SEL.messageActions) };
  }
  // Choice buttons: unlabelled buttons in the question card, outside its free-text <form> (which holds Skip).
  // Header controls such as "Minimize" carry an aria-label and are excluded.
  function questionOptions(group) {
    return byRole(group, "button").filter((b) => !b.closest("form") && !b.hasAttribute("aria-label"));
  }
  function status(doc) {
    const main = doc.querySelector(SEL.main) || doc.body;
    const running = !!(resolve(main, "stop").el || main.querySelector(SEL.streaming));
    const turn = turnState(doc);
    const perm = resolve(main, "permissionGroup");
    const q = resolve(main, "questionGroup");
    if (!running && turn.open && perm.el) {
      const ap = resolve(perm.el, "approve"), dn = resolve(perm.el, "deny");
      if (ap.el && dn.el) return { status: "approval_required", approval: { text: accName(perm.el.closest('[role="group"]') || perm.el), detail: textOf(perm.el).slice(0, 400), confidence: Math.min(perm.confidence, ap.confidence, dn.confidence) } };
    }
    if (!running && turn.open && q.el) {
      const options = questionOptions(q.el).map((b) => accName(b).replace(/^\d+\s+/, ""));
      return { status: "waiting_for_input", question: { text: accName(q.el), options, confidence: q.confidence } };
    }
    const staleCard = (perm.el || q.el) ? true : undefined;
    if (running) return { status: "working", staleCard };
    // An assistant turn without its actions bar is still in progress (e.g. continuing after an approval or
    // answer, or running a remote tool) even when no Stop button / streaming flag is rendered.
    if (turn.open && !(turn.last && TEXT.interrupted.test(turn.last.textContent))) return { status: "working", staleCard, via: "open-turn" };
    const msgs = main.querySelectorAll(SEL.message);
    const composer = resolve(doc, "composer");
    if (!msgs.length && !composer.el) return { status: "unknown", reason: "no transcript and no composer" };
    if (turn.last && TEXT.interrupted.test(turn.last.textContent)) return { status: "interrupted", staleCard };
    if (turn.last && turn.last.querySelector(SEL.assistantMessage) && TEXT.failed.test(turn.last.textContent)) return { status: "failed", staleCard };
    return { status: "idle", staleCard };
  }

  // ---- health check ----
  function doctor(doc) {
    const main = doc.querySelector(SEL.main);
    const id = identity(doc);
    const composer = resolve(doc, "composer");
    const checks = {
      claudePage: doc.location.hostname === "claude.ai" ? "PASS" : "FAIL",
      main: main ? "PASS" : "FAIL",
      sidebarRows: doc.querySelector(SEL.sidebarRow) ? "PASS" : "FAIL",
      sessionIdentity: id.sessionId ? (id.verified ? "PASS" : "FAIL") : "N/A (no session open)",
      composer: composer.el ? (composer.confidence >= ACTION_MIN_CONF ? "PASS" : "DEGRADED") : (id.sessionId ? "FAIL" : "N/A"),
      transcript: doc.querySelector(SEL.message) ? "PASS" : (id.sessionId ? "FAIL" : "N/A"),
      sendControl: resolve(doc, "send").el ? "PASS" : "UNKNOWN (only rendered with text or idle)",
      approvalControls: resolve(doc, "permissionGroup").el ? "PRESENT" : "UNKNOWN (not currently shown)",
    };
    const critical = ["claudePage", "main", "sidebarRows"].every((k) => checks[k] === "PASS");
    const writable = critical && (!id.sessionId || (checks.sessionIdentity === "PASS" && checks.composer === "PASS" && checks.transcript === "PASS"));
    return { mode: !critical ? "broken" : writable ? "read-write" : "read-only", checks, identity: id };
  }

  function snapshot(doc) {
    const id = identity(doc);
    const st = status(doc);
    const msgs = readMessages(doc);
    const last = msgs[msgs.length - 1];
    return { identity: id, ...st, messageCount: msgs.length ? last.total : 0, lastIndex: last ? last.index : 0, lastRole: last ? last.role : null, lastTextLength: last ? last.text.length : 0, lastTurnKey: last && last.turnKey };
  }

  root.CoworkDom = { CONF, ACTION_MIN_CONF, SEL, BUNDLES, TEXT, norm, textOf, accName, resolve, questionOptions, identity, listSidebarSessions, readMessages, status, doctor, snapshot };
})(globalThis);
