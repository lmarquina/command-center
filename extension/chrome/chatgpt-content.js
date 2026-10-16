// ChatGPT content script: actions with pre/postconditions + MutationObserver events for chatgpt.com.
// Scope (per user decision 2026-10-06): the user's own logged-in tab; one action at a time; no bulk extraction,
// no backend/API calls, no rate-limit evasion. Approvals/questions are not supported (ChatGPT has no structured ones).
(() => {
  if (globalThis.__chatgptBridgeLoaded) return;
  globalThis.__chatgptBridgeLoaded = true;
  const D = globalThis.ChatGPTDom, E = globalThis.CoworkProtocol.ERR;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
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

  function requireSession(expect) {
    const id = D.identity(document);
    if (!id.verified) fail(E.IDENTITY, "chat identity not verified (no /c/<uuid> or still provisional)", { identity: id });
    if (expect && expect.length && !expect.includes(id.sessionId)) fail(E.IDENTITY, `open chat is ${id.sessionId}, expected ${expect[0]}`, { identity: id });
    return id;
  }
  async function typeAndSend(message, force) {
    const want = D.norm(message).slice(0, 40);
    let comp = await waitFor(() => document.querySelector(D.SEL.composer), 5000);
    if (!comp) fail(E.NOT_FOUND, "composer not found");
    if (D.norm(comp.textContent) && !force) fail(E.STATE, "composer has a draft; refusing to overwrite (pass force)", { draftPreview: D.norm(comp.textContent).slice(0, 60) });
    // The editor can be re-mounted right after navigation (e.g. New chat); re-query and retry insertion briefly.
    let landed = false;
    for (let attempt = 0; attempt < 4 && !landed; attempt++) {
      comp = document.querySelector(D.SEL.composer) || comp;
      comp.focus();
      if (attempt < 2) {
        if (force || attempt > 0) document.execCommand("selectAll", false);
        document.execCommand("insertText", false, message);
      } else {
        // Fallback for long-hidden tabs where execCommand silently does nothing: write the paragraph directly;
        // the editor (ProseMirror) observes DOM changes and adopts the text. Verified below like the normal path.
        const p = document.createElement("p"); p.textContent = message;
        comp.replaceChildren(p);
        comp.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: message }));
      }
      landed = !!(await waitFor(() => { const c = document.querySelector(D.SEL.composer); return c && D.norm(c.textContent).includes(want); }, 1200));
      if (!landed) await settle(400);
    }
    if (!landed) fail(E.VERIFY, "text did not land in composer");
    const send = await waitFor(() => { const r = D.resolveButton(document, D.BTN.send); return r.el && !r.el.disabled && r.confidence >= D.ACTION_MIN_CONF ? r : null; }, 3000);
    if (!send) fail(E.LOW_CONF, "Send button not found/enabled with sufficient confidence");
    send.el.click();
  }

  // See content-script.js: the extension's own background tab is marked through window.name; only it
  // publishes the chat list.
  const OWNED = "cc-bridge";
  const owned = () => window.name === OWNED;
  const handlers = {
    identity: () => ({ ...D.identity(document), ready: !!document.querySelector(D.SEL.composer) && Date.now() - lastMutationAt > 600, owned: owned() }),
    mark: () => { window.name = OWNED; listSig = null; setTimeout(listTick, 0); return { owned: true }; },
    health: async () => {
      const app = await waitFor(() => document.querySelector(D.SEL.composer) || document.querySelector("nav"), 8000);
      const loginButton = [...document.querySelectorAll("button, a")].some((b) => /^log in$/i.test((b.textContent || "").trim()));
      return { owned: owned(), signedIn: !!app && !loginButton && !/^\/auth/.test(location.pathname), path: location.pathname };
    },
    doctor: () => D.doctor(document),
    list: () => ({ sessions: D.listSidebar(document), source: "sidebar (rendered rows only)" }),
    navigate: ({ path }) => {
      if (!/^\/c\/[0-9a-f-]{36}$/.test(path)) fail(E.STATE, `refusing to navigate to ${path}`);
      const link = [...document.querySelectorAll(D.SEL.sidebarConv)].find((a) => a.getAttribute("href").endsWith(path));
      if (link) { link.click(); return { method: "spa" }; }
      setTimeout(() => location.assign(path), 30);
      return { method: "full" };
    },
    read: ({ expect, limit = 20 }) => { const id = requireSession(expect); const m = D.readMessages(document); return { sessionId: id.sessionId, identity: id, rendered: m.length, total: m.length, messages: m.slice(-limit).map((x, i) => ({ index: m.length - Math.min(limit, m.length) + i + 1, ...x })) }; },
    status: ({ expect }) => { const id = requireSession(expect); return { sessionId: id.sessionId, identity: id, ...D.status(document) }; },
    send: async ({ expect, message, force }) => {
      const id = requireSession(expect);
      if (D.status(document).status === "working") fail(E.STATE, "ChatGPT is still responding; stop it first (ChatGPT has no steering)");
      const before = D.readMessages(document).filter((m) => m.role === "user").length;
      await typeAndSend(message, force);
      const landed = await waitFor(() => { const u = D.readMessages(document).filter((m) => m.role === "user"); return u.length > before && D.norm(u[u.length - 1].text).includes(D.norm(message).slice(0, 60)) ? u[u.length - 1] : null; }, 10000);
      const after = D.identity(document);
      if (after.sessionId !== id.sessionId) fail(E.VERIFY, `chat changed after send (${id.sessionId} → ${after.sessionId})`);
      if (!landed) fail(E.VERIFY, "sent message did not appear within 10s");
      return { sessionId: id.sessionId, messageId: landed.messageId, status: D.status(document).status };
    },
    newChat: async ({ message, force }) => {
      if (!message) fail(E.STATE, "newChat needs a first message");
      if (D.identity(document).sessionId) {
        const nc = D.resolveButton(document, D.BTN.newChat);
        if (!nc.el) fail(E.NOT_FOUND, "New chat button not found");
        nc.el.click();
        if (!(await waitFor(() => !D.identity(document).sessionId && document.querySelector(D.SEL.composer), 8000))) fail(E.VERIFY, "did not reach an empty new chat");
        // Wait for the fresh editor itself, not for a quiet page: in a long-hidden tab a quiet page means timers fire
        // about once a minute, and a fixed pause here took longer than the whole request is allowed.
        await waitFor(() => { const c = document.querySelector(D.SEL.composer); return c && c.isConnected && c.getAttribute("contenteditable") === "true" ? c : null; }, 5000);
      }
      await typeAndSend(message, !!force);
      const id = await waitFor(() => { const i = D.identity(document); return i.verified ? i : null; }, 20000, 200);
      if (!id) fail(E.VERIFY, "new chat id did not settle (still provisional after 20s)");
      return { sessionId: id.sessionId, identity: id, status: D.status(document).status };
    },
    stop: async ({ expect }) => {
      const id = requireSession(expect);
      const s = D.resolveButton(document, D.BTN.stop);
      if (!s.el) fail(E.STATE, "not responding (no Stop button)");
      if (s.confidence < D.ACTION_MIN_CONF) fail(E.LOW_CONF, "Stop button ambiguous");
      s.el.click();
      const done = await waitFor(() => D.status(document).status !== "working", 10000, 200);
      return { sessionId: id.sessionId, status: done ? "interrupted" : "working", verified: !!done };
    },
    approve: () => fail(E.STATE, "ChatGPT exposes no structured approvals to the bridge"),
    deny: () => fail(E.STATE, "ChatGPT exposes no structured approvals to the bridge"),
    answer: () => fail(E.STATE, "ChatGPT questions are plain prose; reply with send"),
    snapshot: () => ({ snapshot: D.snapshot(document), html: "" }),
  };

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.kind !== "rpc") return;
    const h = handlers[msg.method];
    const LANE = { send: 0, newChat: 0, stop: 0 };
    Promise.resolve().then(() => { if (!h) fail(E.UNKNOWN_METHOD, msg.method); return msg.method in LANE ? ui(LANE[msg.method], () => h(msg.params || {})) : h(msg.params || {}); })
      .then((result) => reply({ ok: true, result }), (e) => reply({ ok: false, error: { code: e.code || "ERROR", message: e.message, details: e.details } }));
    return true;
  });

  // ---- events (MutationObserver on <body>: chatgpt.com swaps <main> on navigation) ----
  let prev = null, timer = null, firstDirty = 0, lastMutationAt = Date.now(), seen = new Map();
  const emit = (event, data) => chrome.runtime.sendMessage({ kind: "event", provider: "chatgpt", event, ...data, at: new Date().toISOString() }).catch(() => {});
  function evaluate() {
    timer = null; firstDirty = 0;
    let s, msgs; try { s = D.snapshot(document); msgs = D.readMessages(document); } catch { return; }
    const sid = s.identity.verified ? s.identity.sessionId : null;
    if (!sid) { prev = s; return; }
    if (!prev || prev.identity.sessionId !== sid) { emit("session.changed", { sessionId: sid, status: s.status }); seen = new Map(msgs.map((m) => [m.messageId, m.text.length])); prev = s; return; }
    for (const m of msgs) {
      if (!seen.has(m.messageId)) { seen.set(m.messageId, m.text.length); emit("session.messageAdded", { sessionId: sid, key: m.messageId, role: m.role, text: m.text.slice(0, 2000) }); }
      else if (m.role === "assistant" && seen.get(m.messageId) !== m.text.length) { const p = seen.get(m.messageId); seen.set(m.messageId, m.text.length); emit("session.messageUpdated", { sessionId: sid, key: m.messageId, textLength: m.text.length, delta: m.text.slice(p, p + 2000) }); }
    }
    if (s.status !== prev.status) {
      emit("session.statusChanged", { sessionId: sid, from: prev.status, status: s.status });
      if (prev.status === "working" && s.status === "idle") {
        const last = msgs.filter((m) => m.role === "assistant").pop();
        if (last) emit("session.messageFinal", { sessionId: sid, key: last.messageId, text: last.text.slice(0, 8000) });
        emit("session.completed", { sessionId: sid });
      }
    }
    prev = s;
  }
  // session list stream (sidebar) + one UI lane for page-changing actions
  const uiQ = []; let uiBusy = false, uiSeq = 0;
  function ui(prio, fn) { return new Promise((res, rej) => { uiQ.push({ prio, fn, res, rej, n: uiSeq++ }); uiQ.sort((a, b) => a.prio - b.prio || a.n - b.n); pumpUi(); }); }
  async function pumpUi() { if (uiBusy || !uiQ.length) return; const j = uiQ.shift(); uiBusy = true; try { j.res(await j.fn()); } catch (e) { j.rej(e); } finally { uiBusy = false; pumpUi(); } }
  let listSig = null, listTimer = null;
  const hash = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; };
  function listTick() { listTimer = null; if (!owned()) return; let rows; try { rows = D.listSidebar(document); } catch { return; } const sig = JSON.stringify(rows.map((r) => [r.sessionId, r.title])); if (sig !== listSig) { listSig = sig; emit("session.listChanged", { sessionId: "_list", sessions: rows, sig: hash(sig) }); } }
  let lastTick = 0;   // mutation-driven (timers are throttled in hidden tabs)
  new MutationObserver(() => { const now = Date.now(); clearTimeout(listTimer); if (now - lastTick >= 900) { lastTick = now; listTick(); } else listTimer = setTimeout(() => { lastTick = Date.now(); listTick(); }, 900); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "aria-label"] });
  setTimeout(listTick, 1500);
  function schedule() { const now = Date.now(); lastMutationAt = now; if (!firstDirty) firstDirty = now; clearTimeout(timer); timer = setTimeout(evaluate, now - firstDirty > 1000 ? 0 : 250); }
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "data-talvt-turn-state", "disabled"] });
  schedule();
  chrome.runtime.sendMessage({ kind: "hello", provider: "chatgpt", identity: D.identity(document), url: location.href }).catch(() => {});
})();
