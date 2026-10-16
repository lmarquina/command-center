// Command Center - Even Hub app for G2. THIN CLIENT: renders server-sent pages, forwards input. No provider logic.
import {
  waitForEvenAppBridge, CreateStartUpPageContainer, RebuildPageContainer, TextContainerUpgrade,
  TextContainerProperty, ListContainerProperty, ListItemContainerProperty, ImageContainerProperty, ImageRawDataUpdate, OsEventTypeList, AudioInputSource, ImuReportPace,
} from "@evenrealities/even_hub_sdk";

const G2_PORT = __GLASSES_PORT__;   // from config gateway.glasses.port (vite.config.js)
const log = (...a) => console.log("[g2cc]", ...a);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

// token arrives once via the QR URL fragment (#t=...), never in a request; then persisted on the phone
const frag = new URLSearchParams(location.hash.slice(1));
if (frag.get("t")) { store.set("cc_token", frag.get("t")); history.replaceState(null, "", location.pathname); }
const TOKEN = store.get("cc_token");
// https (phone, via Tailscale name) → wss on 3100; local http (desktop simulator) → plain ws on 127.0.0.1:3101
const WS_URL = location.protocol === "https:" ? `wss://${location.hostname}:${G2_PORT}` : /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? `ws://${location.hostname}:${G2_PORT + 1}` : `ws://${location.hostname}:${G2_PORT}`;

let bridge, ws, started = false, screen = "home", backoff = 500;
let ptt = false, pttAuto = false, pttTimer = null, frames = 0, player = null;
const report = (what, extra = {}) => { log(what, JSON.stringify(extra)); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "log", what, ...extra })); };

// ---------- push-to-talk with a warm mic ----------
// The glasses mic stays on while the app is in the foreground; the last PRE_BYTES of audio are kept in phone memory
// only. On hold, that pre-roll + live audio streams to the Mac, so words spoken at the moment of touch are kept.
// Nothing is sent unless the touchpad is held. Mic goes off when the app leaves the foreground.
const PRE_BYTES = 16000 * 2 * 1.5; // 1.5 s of 16 kHz s16le
let micOn = false, micTried = false, ring = [], ringBytes = 0;
let micBusy = null; // one audioControl call at a time (concurrent calls reset the mic mid-recording)
async function micWarm(on) {
  if (micBusy) { await micBusy.catch(() => {}); }
  if (on === micOn) return;
  micBusy = (async () => {
    try {
      const ok = await bridge.audioControl(on, AudioInputSource.Glasses); micOn = on && !!ok; report(on ? "mic warm" : "mic off", { ok });
      if (on && !ok) setTimeout(() => { if (!micOn) micWarm(true); }, 2000); // e.g. page not ready yet: retry
    } catch (e) { report("mic error", { err: String(e && e.message) }); }
    if (!on) { ring = []; ringBytes = 0; }
  })();
  try { await micBusy; } finally { micBusy = null; }
}
// ---------- free talk: phone-side voice detection (only the user's own voice; never while a reply is playing) ----------
let free = false, vad = { voiced: 0, quiet: 0, floor: null, on: false, t0: 0 }, playing = false;
function frameRms(pcm) { const v = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2)); let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s / Math.max(1, v.length)) / 32768; }
function freeTalk(pcm, role) {
  const rms = frameRms(pcm), ms = (pcm.byteLength / 2) / 16;                        // frame duration in ms
  vad.floor = vad.floor == null ? rms : rms < vad.floor ? vad.floor * 0.9 + rms * 0.1 : vad.floor * 0.999 + rms * 0.001;
  const loud = rms > Math.max(0.012, vad.floor * 3) && role !== "other" && !playing;
  if (!vad.on) {
    vad.voiced = loud ? vad.voiced + ms : 0;
    if (vad.voiced >= 150) { vad.on = true; vad.quiet = 0; vad.t0 = Date.now(); pttStart(true); }   // pre-roll goes with it
  } else {
    vad.quiet = loud ? 0 : vad.quiet + ms;
    // short utterances (commands) end after 0.8 s of silence; past 4 s it's dictation: allow 2 s pauses; max 3 min
    const pause = Date.now() - vad.t0 > 4000 ? 2000 : 800;
    if (vad.quiet >= pause || Date.now() - vad.t0 > 180000 || playing) { vad.on = false; vad.voiced = 0; pttEnd(); }
  }
}
function onAudio(pcm, role) {
  if (free && !ptt) freeTalk(pcm, role);
  else if (free && ptt && vad.on) freeTalk(pcm, role);
  if (ptt) { if (ws && ws.readyState === 1) { ws.send(pcm); frames++; } return; }
  ring.push(pcm); ringBytes += pcm.length;
  while (ring.length > 1 && ringBytes - ring[0].length >= PRE_BYTES) ringBytes -= ring.shift().length;
}
async function pttStart(auto) {
  if (ptt || !ws || ws.readyState !== 1) return;
  if (!micOn) await micWarm(true);
  ws.send(JSON.stringify({ type: "ptt", state: "start", ...(auto === true ? { auto: true } : {}) }));
  const pre = ring; ring = []; ringBytes = 0; ptt = true; pttAuto = auto === true; frames = 0;
  for (const f of pre) ws.send(f);                      // pre-roll first, then live frames
  report("ptt start", { preroll_ms: Math.round(pre.reduce((a, f) => a + f.length, 0) / 32) });
  pttTimer = setTimeout(pttEnd, 300000);                // hard cap 5 min, same as the Mac side
}
async function pttEnd() {
  if (!ptt) return; ptt = false; clearTimeout(pttTimer);
  report("ptt end", { frames });
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ptt", state: "end" }));
}

// ---------- spoken output: WAV from the Mac, played by the phone (→ AirPods if connected) ----------
// iOS: declare media playback so the ring/silent switch doesn't mute spoken replies (Audio Session API, iOS 16.4+).
const audioSession = (() => { try { if (navigator.audioSession) { navigator.audioSession.type = "playback"; return navigator.audioSession.type; } } catch (e) { return "error:" + e.message; } return "unavailable"; })();
async function play(b64, voice, method) {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  try {
    if (method === "webaudio") throw new Error("forced webaudio");
    if (player) { player.pause(); URL.revokeObjectURL(player.src); }
    player = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
    player.onplaying = () => { playing = true; }; player.onended = player.onpause = player.onerror = () => { setTimeout(() => { playing = false; }, 400); };
    player.volume = 1; await player.play();
    report("audio played", { via: "audio-element", voice, bytes: bytes.length, audioSession, muted: player.muted, ua: navigator.userAgent.slice(0, 90) });
  } catch (e1) {
    try { // fallback: Web Audio
      const ac = play.ctx || (play.ctx = new (window.AudioContext || window.webkitAudioContext)()); await ac.resume();
      const buf = await ac.decodeAudioData(bytes.buffer.slice(0)); const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination); src.start();
      report("audio played", { via: "webaudio", voice, state: ac.state, sampleRate: ac.sampleRate, dur: buf.duration });
    } catch (e2) { report("audio failed", { e1: String(e1 && e1.message), e2: String(e2 && e2.message) }); }
  }
}

function toSdk(page) {
  const textObject = [], listObject = [], imageObject = [];
  const z = page.containers.some((c) => c.kind === "image");   // z-order is all-or-nothing: set it everywhere when images exist
  page.containers.forEach((c, i) => {
    const base = { xPosition: c.xPosition, yPosition: c.yPosition, width: c.width, height: c.height, containerID: c.containerID, containerName: c.containerName, ...(z ? { zOrderIndex: c.kind === "image" ? 10 + i : 1 + i } : {}) };
    const deco = {}; for (const k of ["borderWidth", "borderColor", "borderRadius", "paddingLength"]) if (c[k] != null) deco[k] = c[k];
    if (c.kind === "text") textObject.push(new TextContainerProperty({ ...base, ...deco, isEventCapture: c.isEventCapture, content: c.content, ...(c.textColor != null ? { textColor: c.textColor } : {}) }));
    if (c.kind === "list") listObject.push(new ListContainerProperty({ ...base, ...deco, isEventCapture: c.isEventCapture, itemContainer: new ListItemContainerProperty(c.itemContainer) }));
    if (c.kind === "image") imageObject.push(new ImageContainerProperty(base));
  });
  return { containerTotalNum: textObject.length + listObject.length + imageObject.length, textObject, listObject, ...(imageObject.length ? { imageObject } : {}) };
}

// Images: the page creates empty placeholders; PNGs are then sent one at a time (no concurrent image sends).
const pngCache = new Map(); let renderSeq = 0;
async function pngBase64(src) {
  if (!pngCache.has(src)) pngCache.set(src, fetch(src).then((r) => r.arrayBuffer()).then((b) => btoa(String.fromCharCode(...new Uint8Array(b)))));
  return pngCache.get(src);
}
async function sendImages(page, seq) {
  for (const c of page.containers.filter((x) => x.kind === "image" && x.src)) {
    if (seq !== renderSeq) return;   // a newer page replaced this one
    try { await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: c.containerID, containerName: c.containerName, imageData: await pngBase64(c.src) })); }
    catch (e) { report("image error", { src: c.src, err: String(e && e.message) }); }
  }
}

// ---------- walking mode: big type drawn here, sent as 4 image tiles (only changed tiles are resent) ----------
let currentPage = null, lastTiles = [], bigSeq = 0;
function drawBig(big) {
  const cv = document.createElement("canvas"); cv.width = 576; cv.height = 288; const g = cv.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, 576, 288); g.textBaseline = "top";
  const rows = [];   // wrap each line to the canvas width at its own size
  for (const l of big.lines || []) {
    g.font = `800 ${l.size}px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif`;
    let cur = "";
    for (const w of String(l.text).split(" ")) { const t = cur ? cur + " " + w : w; if (g.measureText(t).width > 552 && cur) { rows.push({ ...l, text: cur }); cur = w; } else cur = t; }
    rows.push({ ...l, text: cur });
  }
  const gap = 10, total = rows.reduce((a, r) => a + r.size * 1.05, 0) + gap * (rows.length - 1);
  let y = Math.max(6, (288 - total) / 2);
  for (const r of rows) { g.font = `800 ${r.size}px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif`; g.fillStyle = r.dim ? "#7a7a7a" : "#ffffff"; g.fillText(r.text, 12, y); y += r.size * 1.05 + gap; }
  return [[0, 0], [288, 0], [0, 144], [288, 144]].map(([x, y0]) => {
    const t = document.createElement("canvas"); t.width = 288; t.height = 144; t.getContext("2d").drawImage(cv, x, y0, 288, 144, 0, 0, 288, 144);
    return t.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  });
}
async function renderBig(big, page, fresh) {
  const seq = ++bigSeq; const tiles = drawBig(big); if (fresh) lastTiles = [];
  const conts = (page || currentPage || { containers: [] }).containers.filter((c) => c.kind === "image" && c.tile != null);
  for (const c of conts) {
    if (seq !== bigSeq) return;                  // newer content arrived: skip stale tiles
    if (lastTiles[c.tile] === tiles[c.tile]) continue;
    try { await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: c.containerID, containerName: c.containerName, imageData: tiles[c.tile] })); lastTiles[c.tile] = tiles[c.tile]; }
    catch (e) { report("tile error", { err: String(e && e.message) }); }
  }
}

// ---------- phone locked / app hidden → tell the Mac (it then sends replies as notifications instead of audio) ----------
document.addEventListener("visibilitychange", () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "visible", on: document.visibilityState === "visible" })); });

// ---------- motion: IMU readings → Mac (walking detection runs there) ----------
let imuOn = false, imuWanted = true;
async function imu(on) { imuWanted = on; return imuSet(on); }
async function imuSet(on) { if (on === imuOn) return; try { await bridge.imuControl(on, ImuReportPace.P100); imuOn = on; report(on ? "imu on" : "imu off"); } catch (e) { report("imu error", { err: String(e && e.message) }); } }

async function show(page) {
  const spec = toSdk(page); const seq = ++renderSeq;
  if (!started) { const r = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(spec)); started = true; log("startup", r); }
  else await bridge.rebuildPageContainer(new RebuildPageContainer(spec));
  screen = page.screen;
  store.set("cc_resume", JSON.stringify({ screen: "home" })); // resume at home (server owns deeper state)
  currentPage = page;
  if (page.big) renderBig(page.big, page, true); else { lastTiles = []; sendImages(page, seq); }
}
async function update(updates) {
  for (const u of updates) await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: u.containerID, containerName: u.containerName, content: u.content, ...(u.textColor != null ? { textColor: u.textColor } : {}) }));
}
async function status(text) {
  const page = { screen: "status", containers: [{ kind: "text", containerID: 1, containerName: "hdr", xPosition: 0, yPosition: 0, width: 576, height: 288, isEventCapture: 1, content: text }] };
  await show(page);
}

function connect() {
  if (!TOKEN) { status("COMMAND CENTER\n\nNot paired.\nScan the pairing QR shown on your Mac."); return; }
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { backoff = 500; ws.send(JSON.stringify({ type: "hello", token: TOKEN, device: "g2" })); setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "visible", on: document.visibilityState === "visible" })); }, 500); };
  ws.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    try {
      if (msg.type === "render" && msg.mode === "rebuild") { await show(msg.page); if (!micOn && !micBusy && !micTried) { micTried = true; micWarm(true).then(() => imu(imuWanted)); } }
      else if (msg.type === "render" && msg.mode === "big") await renderBig(msg.big, currentPage, false);
      else if (msg.type === "imu") await imu(!!msg.on);
      else if (msg.type === "free") { free = !!msg.on; vad = { voiced: 0, quiet: 0, floor: null, on: false, t0: 0 }; if (free && !micOn) micWarm(true); report("free talk", { on: free }); }   // the Mac decides: off in "normal mode" (saves Bluetooth bandwidth)
      else if (msg.type === "render" && msg.mode === "update") await update(msg.updates);
      else if (msg.type === "toast") await update([{ containerID: 1, containerName: "hdr", content: msg.text }]);
      else if (msg.type === "ack") { screen = msg.screen; log("ack", msg.ms, "ms", msg.screen); }
      else if (msg.type === "audio") await play(msg.b64, msg.voice, msg.method);
    } catch (e) { log("render error", e && e.message); }
  };
  ws.onclose = (e) => {
    log("ws closed", e.code);
    if (e.code === 4003) { store.set("cc_token", ""); status("COMMAND CENTER\n\nPairing rejected.\nScan a new pairing QR."); return; }
    status(`COMMAND CENTER\n\nMac not reachable.\nRetrying...`).catch(() => {});
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000);
  };
}

const EVT = { [OsEventTypeList.CLICK_EVENT]: "click", [OsEventTypeList.DOUBLE_CLICK_EVENT]: "double_click", [OsEventTypeList.SCROLL_TOP_EVENT]: "up", [OsEventTypeList.SCROLL_BOTTOM_EVENT]: "down", [OsEventTypeList.LONG_PRESS_EVENT]: "long_press" };
function onEvent(e) {
  if (e.audioEvent) { if (e.audioEvent.audioPcm) onAudio(e.audioEvent.audioPcm, e.audioEvent.speakerRole); return; }
  if (e.sysEvent && e.sysEvent.eventType === OsEventTypeList.IMU_DATA_REPORT) {
    const d = e.sysEvent.imuData; if (d && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "imu", x: d.x, y: d.y, z: d.z }));
    return;
  }
  const src = e.listEvent || e.textEvent || e.sysEvent;
  if (!src) return;
  const type = src.eventType ?? OsEventTypeList.CLICK_EVENT; // CLICK (0) can arrive without an explicit eventType
  if (type === OsEventTypeList.FOREGROUND_ENTER_EVENT) { if (!ws || ws.readyState > 1) connect(); micTried = true; micWarm(true).then(() => imuSet(imuWanted)); return; }
  if (type === OsEventTypeList.FOREGROUND_EXIT_EVENT) { if (ptt) pttEnd(); micWarm(false); imuSet(false); return; }
  const side = { 1: "right", 2: "ring", 3: "left" }[src.eventSource ?? (e.sysEvent && e.sysEvent.eventSource)] || "?";
  if (type === OsEventTypeList.LONG_PRESS_EVENT) report("hold", { side });                // which touchpad (system menu diagnosis)
  if (type === OsEventTypeList.LONG_PRESS_EVENT && side === "left") return;       // left temple = Even's system menu: never talk there
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT && side === "left" && !ptt) return;
  if (type === OsEventTypeList.LONG_PRESS_EVENT) {                                 // hold = talk
    if (ptt) { report("ptt restart (release was lost)"); pttEnd().then(pttStart); return; }
    pttStart(); return;
  }
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) { pttEnd(); return; }  // release = transcribe
  const event = EVT[type];
  if (!event) return;
  if (ptt && !pttAuto) { report("ptt ended by " + event + " (release was lost)"); pttEnd(); return; } // a held PTT whose release was lost
  report("tap", { event, index: e.listEvent ? e.listEvent.currentSelectItemIndex ?? 0 : null, screen });   // diagnose missed taps
  // Root page: double-click exits (Even Hub QA requirement); elsewhere it means "back" (server-side).
  if (event === "double_click" && screen === "home") { micWarm(false); bridge.shutDownPageContainer(1); return; }
  const index = e.listEvent ? e.listEvent.currentSelectItemIndex ?? 0 : undefined;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "input", event, index, source: e.sysEvent && e.sysEvent.eventSource }));
}

(async () => {
  bridge = await waitForEvenAppBridge();
  bridge.onEvenHubEvent(onEvent);
  await status("COMMAND CENTER\n\nConnecting to your Mac...");
  connect();
})();
