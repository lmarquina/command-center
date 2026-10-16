// Cowork Bridge service worker: native messaging lifecycle, request routing, tab selection.
// No DOM knowledge here; everything DOM-related is delegated to the content script.
importScripts("protocol.js");
const P = globalThis.CoworkProtocol, E = P.ERR;
// Providers served by this one extension. Session ids: Cowork "cse_…" | "chat:<uuid>"; ChatGPT "chatgpt:<uuid>".
const PROVIDERS = {
  cowork: { match: "https://claude.ai/*", origin: "https://claude.ai", home: "https://claude.ai/recents" },
  chatgpt: { match: "https://chatgpt.com/*", origin: "https://chatgpt.com", home: "https://chatgpt.com/" },
};
const providerOf = (params = {}) => params.provider || (String(params.sessionId || "").startsWith("chatgpt:") ? "chatgpt" : "cowork");

// ---------- native messaging ----------
let port = null, backoffMs = 500, reconnectTimer = null;
function connect() {
  if (port || reconnectTimer) return;
  try {
    port = chrome.runtime.connectNative(P.HOST_NAME); // an open native port keeps this worker alive
  } catch (e) { port = null; scheduleReconnect(); return; }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError && chrome.runtime.lastError.message;
    console.warn("[cowork-bridge] native host disconnected:", why);
    port = null;
    scheduleReconnect();
  });
  port.postMessage({ type: "hello", from: "extension", version: chrome.runtime.getManifest().version });
}
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30000);
}
const post = (m) => { try { port && port.postMessage(m); } catch (e) { /* port died; reconnect handles it */ } };

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------- content-script RPC ----------
function cs(tabId, method, params = {}, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(err(E.TIMEOUT, `content script ${method} timed out`)), timeoutMs);
    chrome.tabs.sendMessage(tabId, { kind: "rpc", method, params }).then(
      (r) => { clearTimeout(t); if (!r) return reject(err(E.NO_TAB, "no content script response")); r.ok ? resolve(r.result) : reject(Object.assign(err(r.error.code, r.error.message), { details: r.error.details })); },
      (e) => { clearTimeout(t); reject(err(E.NO_TAB, `content script unreachable: ${e.message}`)); },
    );
  });
}
const err = (code, message) => Object.assign(new Error(message), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- identity & tabs ----------
// Canonical id: "cse_…" for Cowork rows, "chat:<uuid>" for chat rows. Aliases learned from /cowork/<cse> redirects.
async function aliases() { return (await chrome.storage.local.get("aliases")).aliases || {}; }
async function addAlias(cse, other) { const a = await aliases(); a[cse] = other; a[other] = cse; await chrome.storage.local.set({ aliases: a }); }
function pathFor(sessionId) {
  const g = sessionId.match(/^chatgpt:([0-9a-f-]{36})$/);
  if (g) return `/c/${g[1]}`;
  if (/^cse_[A-Za-z0-9]+$/.test(sessionId)) return `/cowork/${sessionId}`;
  const m = sessionId.match(/^(?:chat:)?([0-9a-f-]{36})$/);
  if (m) return `/chat/${m[1]}`;
  throw err(E.STATE, `not a session id: ${sessionId}`);
}
const canonicalize = (id, prov = "cowork") => (/^[0-9a-f-]{36}$/.test(id) ? (prov === "chatgpt" ? `chatgpt:${id}` : `chat:${id}`) : id);
async function accepted(sessionId) {
  const a = await aliases();
  return [sessionId, a[sessionId]].filter(Boolean);
}
async function providerTabs(prov = "cowork") { return chrome.tabs.query({ url: PROVIDERS[prov].match }); }
const claudeTabs = () => providerTabs("cowork");
async function identityOf(tabId, timeoutMs = 1500) { try { return await cs(tabId, "identity", {}, timeoutMs); } catch { return null; } }

// Tab rule: (1) a tab that already shows the session (the user's own tab is fine then: nothing moves);
// (2) otherwise the extension's own background tab for that site, never one of the user's tabs.
async function pickTab(sessionId, prov = "cowork") {
  if (sessionId) {
    const ok = await accepted(sessionId);
    const match = (id) => id && id.verified && ok.includes(id.sessionId);
    const tabs = (await providerTabs(prov)).filter((t) => !t.discarded);
    // A frozen/discarded tab never answers, so a short timeout keeps it from stalling every call.
    const ids = await Promise.all(tabs.map((t) => identityOf(t.id, 400)));
    const i = ids.findIndex(match);
    if (i >= 0) return { tab: tabs[i], identity: ids[i] };
  }
  return { tab: await ownedTab(prov), identity: null };
}

// The extension's own tab per site: pinned, in the background, never discarded, marked through window.name
// (survives navigation and browser restarts). Found again after a restart, recreated if the user closed it.
const ownedLocks = {};
function ownedTab(prov) { return (ownedLocks[prov] = (ownedLocks[prov] || Promise.resolve()).then(() => findOrCreateOwned(prov), () => findOrCreateOwned(prov))); }
async function findOrCreateOwned(prov) {
  const key = `ownedTab:${prov}`;
  const known = (await chrome.storage.local.get(key))[key];
  const tabs = await providerTabs(prov);
  let tab = tabs.find((t) => t.id === known);
  if (!tab) {
    const ids = await Promise.all(tabs.map((t) => identityOf(t.id, 800)));
    const i = ids.findIndex((id) => id && id.owned);
    tab = i >= 0 ? tabs[i] : null;
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: PROVIDERS[prov].home, active: false, pinned: true });
    await waitForContentScript(tab.id);
    await cs(tab.id, "mark");
  }
  if (tab.autoDiscardable !== false) await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await chrome.storage.local.set({ [key]: tab.id });
  return tab;
}

// Tabs opened before the extension was (re)loaded have no content script: reload such a tab once.
async function waitForContentScript(tabId, timeoutMs = 20000) {
  let id = await identityOf(tabId);
  if (id) return id;
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") await chrome.tabs.reload(tabId);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { id = await identityOf(tabId); if (id) return id; await sleep(300); }
  throw err(E.TIMEOUT, "content script did not come up (tab reloaded once)");
}

async function ensureOpen(rawId, prov = "cowork") {
  const sessionId = canonicalize(rawId, prov);
  let { tab, identity } = await pickTab(sessionId, prov);
  if (identity) return { tab, identity, sessionId, navigated: false };
  const path = pathFor(sessionId);
  const prevId = (await waitForContentScript(tab.id)).sessionId;
  let method;
  try { method = (await cs(tab.id, "navigate", { path }, 9000)).method; }   // may expand a pinned project first
  catch { method = "tabs.update"; await chrome.tabs.update(tab.id, { url: PROVIDERS[prov].origin + path }); }
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    await sleep(250);
    const id = await identityOf(tab.id);
    if (!id || !id.verified || !id.ready) continue;
    if (id.sessionId === sessionId) return { tab, identity: id, sessionId, navigated: method };
    // /cowork/<cse> of a chat-kind session redirects to /chat/<uuid> whose row is "chat:<uuid>".
    if (sessionId.startsWith("cse_") && id.kind === "chat" && (id.sessionId !== prevId || Date.now() - t0 > 4000) && Date.now() - t0 > 1500) {
      await addAlias(sessionId, id.sessionId);
      return { tab, identity: { ...id, aliasOf: sessionId, verification: "redirect" }, sessionId, navigated: method };
    }
  }
  const id = await identityOf(tab.id);
  throw Object.assign(err(E.IDENTITY, `could not verify that ${sessionId} opened (page shows ${id && id.sessionId})`), { details: { identity: id } });
}

// ---------- one queue per site ----------
// Anything that may navigate a tab runs here, one job at a time per site. User actions (0) go before reads (1),
// which go before the background project inventory (2), which yields between projects.
const lanes = {};
function lane(prov, prio, fn) {
  const L = (lanes[prov] = lanes[prov] || { q: [], busy: false, n: 0 });
  return new Promise((res, rej) => {
    L.q.push({ prio, fn, res, rej, n: L.n++ }); L.q.sort((a, b) => a.prio - b.prio || a.n - b.n);
    const pump = async () => { if (L.busy || !L.q.length) return; const j = L.q.shift(); L.busy = true; try { j.res(await j.fn()); } catch (e) { j.rej(e); } finally { L.busy = false; pump(); } };
    pump();
  });
}
const PRIO = { "session.send": 0, "session.answer": 0, "session.approve": 0, "session.deny": 0, "session.stop": 0, "session.new": 0 };

// ---------- request routing ----------
async function handle(method, params = {}) {
  const prov = providerOf(params);
  switch (method) {
    case "bridge.reload": setTimeout(() => chrome.runtime.reload(), 200); return { reloading: true };
    case "bridge.tabs": {
      const tabs = await claudeTabs();
      const bridgeTabId = (await chrome.storage.local.get("ownedTab:cowork"))["ownedTab:cowork"];
      return Promise.all(tabs.map(async (t) => { const t0 = Date.now(); const id = await identityOf(t.id, 1500); return { tabId: t.id, bridgeTab: t.id === bridgeTabId, active: t.active, discarded: t.discarded, frozen: t.frozen, status: t.status, url: t.url, sessionId: id && id.sessionId, responded: !!id, ms: Date.now() - t0 }; }));
    }
    case "bridge.ping": return { extension: chrome.runtime.getManifest().version, claudeTabs: (await claudeTabs()).length };
    case "bridge.doctor": {
      const tabs = await providerTabs(prov);
      if (!tabs.length) return { provider: prov, claudeTab: `FAIL (no ${PROVIDERS[prov].origin} tab)`, nativeMessaging: "PASS" };
      const { tab } = await pickTab(null, prov);
      await waitForContentScript(tab.id);
      const d = await cs(tab.id, "doctor");
      return { provider: prov, nativeMessaging: "PASS", claudeTab: `PASS (${tabs.length} tab(s); using ${tab.id})`, tab: { id: tab.id, url: tab.url, active: tab.active }, ...d };
    }
    case "session.new": {
      // ChatGPT only: start a new chat in the provider tab and return its id once the URL settles.
      if (prov !== "chatgpt") throw err(E.STATE, "session.new is only implemented for chatgpt");
      return lane(prov, 0, async () => {
        const { tab } = await pickTab(null, prov);
        await waitForContentScript(tab.id);
        return cs(tab.id, "newChat", params, 60000);
      });
    }
    case "session.list": {
      const { tab } = await pickTab(null, prov);
      await waitForContentScript(tab.id);
      const r = await cs(tab.id, "list");
      if (prov === "cowork") { lastSidebar.cowork = r.sessions; return { ...r, sessions: await withInventory(r.sessions), source: r.source + " + every project page" }; }
      return r;
    }
    case "session.inventory": runInventory("request"); return { started: true, ...(await chrome.storage.local.get("inventory:cowork"))["inventory:cowork"] && { last: (await chrome.storage.local.get("inventory:cowork"))["inventory:cowork"].at } };
    case "bridge.health": return health();
    // Demo recording: one narrow window showing a single session (the sites hide their sidebars at this width),
    // captured by the recorder as a single window, so nothing else on the screen can end up in a frame.
    case "demo.window": {
      const key = "demoWindowId", known = (await chrome.storage.session.get(key))[key];
      const box = { left: params.left ?? 40, top: params.top ?? 40, width: params.width ?? 560, height: params.height ?? 980 };
      let win = known ? await chrome.windows.get(known, { populate: true }).catch(() => null) : null;
      if (win) { await chrome.tabs.update(win.tabs[0].id, { url: params.url }); await chrome.windows.update(win.id, { ...box, focused: true }); }
      else { win = await chrome.windows.create({ url: params.url, ...box, focused: true, type: "popup" }); await chrome.storage.session.set({ [key]: win.id }); }
      return { windowId: win.id };
    }
    case "demo.close": {
      const id = (await chrome.storage.session.get("demoWindowId")).demoWindowId;
      if (id) { await chrome.windows.remove(id).catch(() => {}); await chrome.storage.session.remove("demoWindowId"); }
      return { closed: !!id };
    }
    case "debug.snapshot": {
      const { tab } = params.sessionId ? await ensureOpen(params.sessionId, prov) : await pickTab(null, prov);
      return cs(tab.id, "snapshot");
    }
    case "session.open": return lane(prov, 1, async () => {
      const r = await ensureOpen(params.sessionId, prov);
      return { sessionId: r.sessionId, identity: r.identity, navigated: r.navigated, tabId: r.tab.id };
    });
    case "session.steps": case "session.stepOpen":
    case "session.read": case "session.status": case "session.send": case "session.answer":
    case "session.approve": case "session.deny": case "session.stop": return lane(prov, PRIO[method] ?? 1, async () => {
      const r = await ensureOpen(params.sessionId, prov);
      const expect = [r.identity.sessionId];
      const res = await cs(r.tab.id, method.split(".")[1], { ...params, expect }, 60000);
      return { ...res, requestedId: r.sessionId, aliasOf: r.identity.aliasOf };
    });
    default: throw err(E.UNKNOWN_METHOD, method);
  }
}
function onHostMessage(msg) {
  if (msg && msg.type === "hello") { backoffMs = 500; return; }
  if (!msg || !msg.id || !msg.method) return;
  handle(msg.method, msg.params).then(
    (result) => post({ id: msg.id, ok: true, result }),
    (e) => post({ id: msg.id, ok: false, error: { code: e.code || "ERROR", message: e.message, details: e.details } }),
  );
}

// ---------- health ----------
// Per site: is the extension's own tab there and answering, and is the user signed in. Opening the tab is the
// one repair done here; signing in is left to the user.
async function health() {
  const out = { extension: chrome.runtime.getManifest().version };
  for (const prov of Object.keys(PROVIDERS)) {
    try {
      const tab = await ownedTab(prov);
      await waitForContentScript(tab.id, 15000);
      const h = await cs(tab.id, "health", {}, 15000);
      out[prov] = { ok: h.signedIn, tab: "ok", signedIn: h.signedIn, ...(prov === "cowork" ? { inventoryAt: ((await chrome.storage.local.get("inventory:cowork"))["inventory:cowork"] || {}).at || null } : {}) };
    } catch (e) { out[prov] = { ok: false, tab: "missing", error: e.code || e.message }; }
  }
  return out;
}

// ---------- every project's sessions (claude.ai) ----------
// The sidebar shows recent rows and a few pinned projects; each project's own page lists all its sessions.
// The extension's own tab visits /projects and then each project page, one at a time, between other work.
// Runs at start-up, every 15 minutes, and on request. Results are merged into the session list.
const lastSidebar = { cowork: null };
let inventoryRunning = null;
function runInventory(why) {
  if (inventoryRunning) return inventoryRunning;
  inventoryRunning = (async () => {
    const t0 = Date.now();
    const go = async (path) => { const tab = await ownedTab("cowork"); await chrome.tabs.update(tab.id, { url: "https://claude.ai" + path }); await sleep(800); await waitForContentScript(tab.id, 20000); return tab; };
    const projects = await lane("cowork", 2, async () => cs((await go("/projects")).id, "projectsIndex", {}, 20000));
    const result = [];
    for (const p of projects) {   // one lane job per project, so user actions get in between
      try { const r = await lane("cowork", 2, async () => cs((await go(`/project/${p.id}`)).id, "projectPage", { maxMore: 3 }, 40000)); result.push({ id: p.id, title: r.project || p.title, sessions: r.sessions }); }
      catch (e) { result.push({ id: p.id, title: p.title, error: e.code || e.message, sessions: [] }); }
    }
    await lane("cowork", 2, () => go("/recents")).catch(() => {});
    const inv = { at: new Date().toISOString(), ms: Date.now() - t0, why, projects: result };
    await chrome.storage.local.set({ "inventory:cowork": inv });
    if (lastSidebar.cowork) post({ type: "event", event: "session.listChanged", sessionId: "_list", sessions: await withInventory(lastSidebar.cowork), at: new Date().toISOString() });
    return inv;
  })().finally(() => { inventoryRunning = null; });
  return inventoryRunning;
}
async function withInventory(sidebar) {
  const inv = (await chrome.storage.local.get("inventory:cowork"))["inventory:cowork"];
  return mergeSessions(sidebar || [], inv ? inv.projects.flatMap((p) => p.sessions) : [], await aliases());
}
// Sidebar rows (recency order, grouped "Today" / "Yesterday" / "Oct 8" / "Older") plus project-page rows (exact
// last-activity time). Every row gets an updatedAt where one can be known, so the lists sort by real recency.
function mergeSessions(sidebar, projectRows, aliasMap = {}, now = new Date()) {
  const exact = new Map(projectRows.filter((s) => s.updatedAt).flatMap((s) => [[s.sessionId, s.updatedAt], ...(aliasMap[s.sessionId] ? [[aliasMap[s.sessionId], s.updatedAt]] : [])]));
  const rows = sidebar.map((r, i) => ({ ...r, updatedAt: r.updatedAt || exact.get(r.sessionId) || fromGroup(r.group, i, now) }));
  const seen = new Set(rows.flatMap((r) => [r.sessionId, aliasMap[r.sessionId]].filter(Boolean)));
  for (const s of projectRows) if (!seen.has(s.sessionId)) { seen.add(s.sessionId); rows.push(s); }
  return rows;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fromGroup(group, i, now) {
  const at = (d) => new Date(d.getTime() - i * 1000).toISOString();   // keep the sidebar's own order within a group
  if (group === "Today") return at(now);
  const day = (d) => { const x = new Date(d); x.setHours(23, 59, 0, 0); return x; };
  if (group === "Yesterday") { const y = day(now); y.setDate(y.getDate() - 1); return at(y); }
  const m = String(group || "").match(/^([A-Z][a-z]{2}) (\d{1,2})$/);
  if (m && MONTHS.includes(m[1])) { const d = day(now); d.setMonth(MONTHS.indexOf(m[1]), Number(m[2])); if (d > now) d.setFullYear(d.getFullYear() - 1); return at(d); }
  return undefined;   // "Older" with no project page time: unknown, sorts last
}
if (typeof module !== "undefined") module.exports = { mergeSessions, fromGroup };
chrome.alarms.create("inventory", { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "inventory") runInventory("timer"); });
chrome.runtime.onStartup.addListener(() => setTimeout(() => runInventory("startup"), 5000));
chrome.runtime.onInstalled.addListener(() => setTimeout(() => runInventory("installed"), 5000));

// ---------- events from content scripts ----------
const recent = new Map();
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.kind === "hello") { connect(); post({ type: "event", event: "bridge.tabReady", tabId: sender.tab && sender.tab.id, sessionId: msg.identity && msg.identity.sessionId, at: new Date().toISOString() }); }
  if (msg && msg.kind === "event") {
    connect();
    const { kind, ...rest } = msg;
    if (rest.event === "session.listChanged" && rest.provider !== "chatgpt") {   // add every project's sessions
      lastSidebar.cowork = rest.sessions;
      withInventory(rest.sessions).then((sessions) => post({ type: "event", tabId: sender.tab && sender.tab.id, ...rest, sessions }));
      return;
    }
    // Several tabs may show the same session; forward each logical event once.
    const k = [rest.sessionId, rest.event, rest.key, rest.from, rest.status, rest.textLength, rest.sig].join("|");   // sig: list fingerprint
    const now = Date.now();
    if (recent.get(k) > now - 10000) return;
    recent.set(k, now);
    if (recent.size > 500) for (const [kk, t] of recent) if (t < now - 10000) recent.delete(kk);
    post({ type: "event", tabId: sender.tab && sender.tab.id, ...rest });
  }
});
