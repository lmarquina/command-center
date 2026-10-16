// Pocket mode: Web Push to a "Command Center" home-screen web app on the iPhone (iOS 16.4+).
// Served by the G2 gateway's HTTPS server (Tailscale name). Payloads are end-to-end encrypted per the Web Push
// standard (VAPID + ECDH, keys in run/vapid.json); Apple's push service only relays ciphertext.
// Pairing: the Safari page uses the gateway token ONCE to get a one-time install code (30 min); the installed app
// registers its push subscription with that code, so the main token never lives in a URL or the home-screen app.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";

const CODE_TTL_MS = 30 * 60 * 1000;

export function createPush({ runDir, token, log = () => {}, contact = "mailto:command-center@localhost" }) {
  const vapidFile = path.join(runDir, "vapid.json");
  if (!fs.existsSync(vapidFile)) fs.writeFileSync(vapidFile, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });   // first run on this machine
  const vapid = JSON.parse(fs.readFileSync(vapidFile, "utf8"));
  webpush.setVapidDetails(contact, vapid.publicKey, vapid.privateKey);
  const subsFile = path.join(runDir, "push-subs.json");
  let subs = fs.existsSync(subsFile) ? JSON.parse(fs.readFileSync(subsFile, "utf8")) : [];
  const save = () => fs.writeFileSync(subsFile, JSON.stringify(subs, null, 1), { mode: 0o600 });
  const codes = new Map(); // code -> expiresAt
  const pub = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public-push");
  const okToken = (t) => typeof t === "string" && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  const okCode = (c) => typeof c === "string" && codes.has(c) && codes.get(c) > Date.now();

  async function body(req) { let b = ""; for await (const ch of req) { b += ch; if (b.length > 20000) break; } try { return JSON.parse(b || "{}"); } catch { return {}; } }
  const send = (res, code, data, type = "application/json") => {
    res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(type === "application/json" ? JSON.stringify(data) : data);
  };

  /** HTTP handler for /push/*; returns true if handled. */
  async function handle(req, res) {
    const u = new URL(req.url, "https://x"); if (!u.pathname.startsWith("/push")) return false;
    const p = u.pathname.replace(/\/+$/, "") || "/push";
    try {
      if (req.method === "GET" && (p === "/push" || p === "/push/index.html")) return send(res, 200, page(u.searchParams.get("c")), "text/html; charset=utf-8"), true;
      if (req.method === "GET" && p === "/push/sw.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/push/", "Cache-Control": "no-store" }); res.end(SW); return true; }
      if (req.method === "GET" && p === "/push/manifest.webmanifest") {
        const c = u.searchParams.get("c"); const start = c && /^[A-Za-z0-9_-]{8,64}$/.test(c) ? `/push/?c=${c}` : "/push/";
        return send(res, 200, JSON.stringify({ name: "Command Center", short_name: "Command Center", start_url: start, scope: "/push/", display: "standalone", background_color: "#060e09", theme_color: "#060e09", icons: [180, 192, 512].map((s) => ({ src: `/push/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png" })) }), "application/manifest+json"), true;
      }
      const icon = p.match(/^\/push\/icon-(180|192|512)\.png$/);
      if (req.method === "GET" && icon) { res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" }); res.end(fs.readFileSync(path.join(pub, `icon-${icon[1]}.png`))); return true; }
      if (req.method === "GET" && p === "/push/key") return send(res, 200, { publicKey: vapid.publicKey }), true;
      if (req.method === "POST" && p === "/push/code") {
        const b = await body(req); if (!okToken(b.token)) return send(res, 403, { error: "bad token" }), true;
        for (const [k, exp] of codes) if (exp <= Date.now()) codes.delete(k);   // drop expired codes
        const c = crypto.randomBytes(12).toString("base64url"); codes.set(c, Date.now() + CODE_TTL_MS); return send(res, 200, { code: c }), true;
      }
      if (req.method === "POST" && p === "/push/subscribe") {
        const b = await body(req); if (!okCode(b.code)) return send(res, 403, { error: "install code expired; open the pairing link again" }), true;
        const s = b.subscription; if (!s || !/^https:\/\//.test(s.endpoint || "") || !s.keys) return send(res, 400, { error: "bad subscription" }), true;
        subs = subs.filter((x) => x.endpoint !== s.endpoint).concat([{ endpoint: s.endpoint, keys: s.keys, added: new Date().toISOString() }]); save();
        codes.delete(b.code); const session = crypto.randomBytes(16).toString("base64url"); codes.set(session, Date.now() + 24 * 3600e3); // allow a test push right after
        log("push", "subscribed", new URL(s.endpoint).host); return send(res, 200, { ok: true, test: session }), true;
      }
      if (req.method === "POST" && p === "/push/test") {
        const b = await body(req); if (!okCode(b.code) && !okToken(b.token)) return send(res, 403, { error: "not allowed" }), true;
        const n = await notify({ title: "Command Center", body: "Pocket mode works. Approvals and answers will show up here.", tag: "test" }); return send(res, 200, { sent: n }), true;
      }
      return send(res, 404, { error: "not found" }), true;
    } catch (e) { log("push error", e.message); return send(res, 500, { error: "error" }), true; }
  }

  /** Send to every registered device; drops subscriptions the push service reports as gone. */
  async function notify({ title, body: text, tag, url = "/push/" }) {
    if (!subs.length) return 0;
    const payload = JSON.stringify({ title, body: String(text || "").slice(0, 300), tag, url });
    let ok = 0;
    await Promise.all(subs.map(async (s) => {
      try { await webpush.sendNotification(s, payload, { TTL: 600, urgency: "high", topic: tag ? String(tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) : undefined }); ok++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { subs = subs.filter((x) => x.endpoint !== s.endpoint); save(); } log("push send", e.statusCode || "", e.body ? String(e.body).slice(0, 120) : e.message); }
    }));
    return ok;
  }
  return { handle, notify, count: () => subs.length };
}

const SW = `self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: "Command Center", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Command Center", { body: d.body || "", tag: d.tag, renotify: !!d.tag, data: { url: d.url || "/push/" }, icon: "/push/icon-192.png" }));
});
self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(clients.openWindow((e.notification.data && e.notification.data.url) || "/push/")); });`;

function page(code) {
  const safe = code && /^[A-Za-z0-9_-]{8,64}$/.test(code) ? code : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Command Center</title>
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Command Center">
<meta name="theme-color" content="#060e09"><link rel="apple-touch-icon" href="/push/icon-180.png">
<link rel="manifest" href="/push/manifest.webmanifest${safe ? `?c=${safe}` : ""}">
<style>
:root{--bg:#060e09;--fg:#e9fbe9;--mut:#8fb79a;--acc:#38e66e;--bad:#ff7a7a;--card:#0d1a12;--line:#1f3326}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif;padding:max(24px,env(safe-area-inset-top)) 16px 32px}
main{max-width:520px;margin:0 auto}h1{font-size:22px;margin:8px 0 4px}p{color:var(--mut);margin:8px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-top:16px}
ol{padding-left:20px;margin:8px 0}li{margin:6px 0}b{color:var(--fg)}
button{width:100%;font:inherit;font-weight:600;padding:14px;border-radius:12px;border:0;background:var(--acc);color:#04210f;margin-top:12px}
button.ghost{background:transparent;color:var(--acc);border:1px solid var(--line)}#msg{min-height:1.5em}.err{color:var(--bad)}
</style></head><body><main>
<img src="/push/icon-180.png" width="64" height="64" alt="" style="border-radius:14px">
<h1>Command Center</h1><p>Approvals, questions and answers from your agents, on your lock screen and read aloud in your AirPods.</p>
<div class="card" id="install" hidden><b>Install</b><ol><li>Tap the <b>Share</b> button in Safari.</li><li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open <b>Command Center</b> from your home screen to turn on notifications.</li></ol></div>
<div class="card" id="enable" hidden><b>Notifications</b><p>Tap below and allow notifications.</p><button id="go">Turn on notifications</button><button id="test" class="ghost" hidden>Send a test notification</button></div>
<div class="card" id="tips" hidden><b>Hear them in your AirPods</b><ol><li>Settings → Notifications → <b>Announce Notifications</b> → on, and enable <b>Command Center</b>.</li><li>Optional: in the Even app, allow Command Center notifications to mirror them on the glasses.</li></ol></div>
<p id="msg"></p></main>
<script>
const $=(s)=>document.querySelector(s), msg=(t,bad)=>{$("#msg").textContent=t;$("#msg").className=bad?"err":""};
const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
const code = new URLSearchParams(location.search).get("c"); let testCode = null;
(async () => {
  const t = new URLSearchParams(location.hash.slice(1)).get("t");
  if (t && !standalone) {  // first visit from the pairing link: trade the token for a one-time install code
    history.replaceState(null, "", "/push/");
    const r = await fetch("/push/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) });
    if (!r.ok) return msg("This pairing link is not valid any more.", true);
    location.replace("/push/?c=" + (await r.json()).code); return;
  }
  if (!standalone) { $("#install").hidden = false; if (!code) msg("Open the pairing link from your Mac first.", true); return; }
  if (!code) return msg("Open the pairing link from your Mac, then add this page to your Home Screen again.", true);
  $("#enable").hidden = false; $("#tips").hidden = false;
})();
$("#go").onclick = async () => {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return msg("This iPhone needs iOS 16.4 or later.", true);
    const perm = await Notification.requestPermission(); if (perm !== "granted") return msg("Notifications were not allowed. You can allow them in Settings → Notifications.", true);
    const reg = await navigator.serviceWorker.register("/push/sw.js", { scope: "/push/" }); await navigator.serviceWorker.ready;
    const key = (await (await fetch("/push/key")).json()).publicKey;
    const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((key.length + 3) % 4)), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    const r = await fetch("/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, subscription: sub.toJSON() }) });
    const j = await r.json(); if (!r.ok) return msg(j.error || "Could not register.", true);
    testCode = j.test; $("#go").textContent = "Notifications are on"; $("#go").disabled = true; $("#test").hidden = false; msg("Done. Lock your phone and try the test.");
  } catch (e) { msg("Error: " + e.message, true); }
};
$("#test").onclick = async () => { const r = await fetch("/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: testCode }) }); msg(r.ok ? "Test sent. It should arrive in a few seconds." : "Test failed.", !r.ok); };
</script></body></html>`;
}
