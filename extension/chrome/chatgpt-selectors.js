// ChatGPT (chatgpt.com) DOM contract: the ONLY file that knows chatgpt.com's DOM. Exposes globalThis.ChatGPTDom.
// Evidence: live chatgpt.com (logged in), 2026-10-06. Same conventions as selectors.js (Cowork): semantic hooks,
// textContent-based, confidence-scored, no coordinates.
(function (root) {
  "use strict";
  const CONF = { TESTID: 100, ROLE_EXACT: 90, ROLE_REGEX: 80, STRUCT: 40 };
  const ACTION_MIN_CONF = 80;
  const SEL = {
    main: "main",
    sidebarConv: 'a[data-interactive-row-link="true"][href*="/c/"]',  // aria-label = title
    composer: 'div.ProseMirror[role="textbox"][contenteditable="true"]', // aria-label "Ask ChatGPT"
    unit: "[data-content-search-unit-key]",                           // "<turnKey>:<n>:user|assistant"
    userBubble: '[data-user-message-bubble="true"]',
    assistantText: '[data-markdown-text-style="assistant-message"]',
    assistantMsgId: "[data-chatgpt-selection-message-id]",
    turn: "[data-turn-key]",
  };
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Block-aware text: rendered markdown puts each list item/paragraph in its own element; join them with newlines.
  const BLOCK = /^(P|LI|H[1-6]|PRE|BLOCKQUOTE|TR|DIV|UL|OL|TABLE)$/;
  function blockText(el) {
    let out = "";
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) { if (c.nodeName === "BR") { out += "\n"; continue; } const b = BLOCK.test(c.nodeName); if (b && out && !out.endsWith("\n")) out += "\n"; walk(c); if (b && !out.endsWith("\n")) out += "\n"; }
      }
    })(el);
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }
  const label = (b) => norm(b.getAttribute("aria-label") || b.textContent);
  const buttons = (scope, re) => [...scope.querySelectorAll("button")].filter((b) => re.test(label(b)));

  function resolveButton(doc, re, conf = CONF.ROLE_EXACT) {
    const els = buttons(doc, re);
    return { el: els[els.length - 1] || null, count: els.length, confidence: els.length === 1 ? conf : els.length ? CONF.STRUCT : 0 };
  }
  const BTN = { send: /^Send$/, stop: /^Stop/, voice: /^Start Voice$/, newChat: /^New chat$/, retry: /^(Retry|Try again)$/ };

  function identity(doc) {
    const m = doc.location.pathname.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    const provisional = /\/c\/local-/.test(doc.location.pathname);
    const project = (doc.location.pathname.match(/\/g\/(g-p-[0-9a-f]+)/) || [])[1] || null;
    return { path: doc.location.pathname, sessionId: m ? `chatgpt:${m[1]}` : null, conversationId: m ? m[1] : null, project, provisional, verified: !!m && !provisional, title: norm(doc.title.replace(/^ChatGPT$/, "")) };
  }

  function listSidebar(doc) {
    const seen = new Set(); const out = [];
    for (const a of doc.querySelectorAll(SEL.sidebarConv)) {
      const m = a.getAttribute("href").match(/\/c\/([0-9a-f-]{36})/);
      if (!m || seen.has(m[1])) continue; seen.add(m[1]);
      const proj = (a.getAttribute("href").match(/\/g\/(g-p-[0-9a-f]+)/) || [])[1] || null;
      out.push({ sessionId: `chatgpt:${m[1]}`, kind: "chatgpt", title: norm(a.getAttribute("aria-label") || a.textContent), url: new URL(a.getAttribute("href"), doc.location.origin).href, project: proj, current: doc.location.pathname.includes(m[1]) });
    }
    return out;
  }

  function readMessages(doc) {
    const out = [];
    for (const u of doc.querySelectorAll(SEL.unit)) {
      const key = u.getAttribute("data-content-search-unit-key");
      const role = /:user$/.test(key) ? "user" : /:assistant$/.test(key) ? "assistant" : "unknown";
      if (role === "unknown") continue;
      const ids = (u.getAttribute("data-chatgpt-search-message-ids") || "").split(/\s+/).filter(Boolean);
      const textEl = role === "user" ? u.querySelector(SEL.userBubble) : u.querySelector(SEL.assistantText);
      const msgIdEl = u.querySelector(SEL.assistantMsgId);
      out.push({ key, role, messageId: (msgIdEl && msgIdEl.getAttribute("data-chatgpt-selection-message-id")) || ids[0] || key, text: textEl ? blockText(textEl) : norm(u.textContent).slice(0, 2000) });
    }
    return out;
  }

  // Background tabs render the reply only at completion; the composer button is the reliable live signal.
  function status(doc) {
    const stop = resolveButton(doc, BTN.stop);
    if (stop.el) return { status: "working" };
    const msgs = readMessages(doc);
    const composer = doc.querySelector(SEL.composer);
    if (!composer && !msgs.length) return { status: "unknown", reason: "no composer and no transcript" };
    const lastTurn = [...doc.querySelectorAll(SEL.turn)].pop();
    if (lastTurn && buttons(lastTurn, BTN.retry).length && /something went wrong|error/i.test(lastTurn.textContent)) return { status: "failed" };
    return { status: msgs.length ? "idle" : "idle" };
  }

  function doctor(doc) {
    const id = identity(doc);
    const checks = {
      chatgptPage: doc.location.hostname === "chatgpt.com" ? "PASS" : "FAIL",
      loggedIn: buttons(doc, /^Log in$/).length ? "FAIL (logged out)" : "PASS",
      sidebar: doc.querySelector(SEL.sidebarConv) ? "PASS" : "UNKNOWN (sidebar collapsed or empty)",
      composer: doc.querySelector(SEL.composer) ? "PASS" : "FAIL",
      sessionIdentity: id.sessionId ? (id.verified ? "PASS" : "PROVISIONAL") : "N/A (no chat open)",
      transcript: readMessages(doc).length ? "PASS" : (id.sessionId ? "FAIL" : "N/A"),
      sendOrVoice: resolveButton(doc, /^(Send|Start Voice|Stop)/).el ? "PASS" : "FAIL",
    };
    const critical = checks.chatgptPage === "PASS" && checks.loggedIn === "PASS" && checks.composer === "PASS";
    return { mode: critical && checks.sendOrVoice === "PASS" ? "read-write" : critical ? "read-only" : "broken", checks, identity: id };
  }

  function snapshot(doc) {
    const msgs = readMessages(doc); const last = msgs[msgs.length - 1];
    return { identity: identity(doc), ...status(doc), count: msgs.length, lastKey: last && last.messageId, lastRole: last && last.role, lastLen: last ? last.text.length : 0 };
  }

  root.ChatGPTDom = { CONF, ACTION_MIN_CONF, SEL, BTN, norm, blockText, label, resolveButton, identity, listSidebar, readMessages, status, doctor, snapshot };
})(globalThis);
