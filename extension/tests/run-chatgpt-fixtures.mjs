// Regression tests for chrome/chatgpt-selectors.js (jsdom, synthetic fixture). Run: node tests/run-chatgpt-fixtures.mjs
import fs from "node:fs"; import path from "node:path"; import { JSDOM } from "jsdom";
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = fs.readFileSync(path.join(ROOT, "chrome/chatgpt-selectors.js"), "utf8");
const FX = fs.readFileSync(path.join(ROOT, "fixtures/chatgpt-structure.html"), "utf8");
const load = (button, url = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111") => { const dom = new JSDOM(`<!doctype html><title>Test chat A</title><body>${FX.replace("__BUTTON__", button)}</body>`, { url, runScripts: "outside-only" }); dom.window.eval(SRC); return { D: dom.window.ChatGPTDom, doc: dom.window.document }; };
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("PASS", n); } catch (e) { fail++; console.log("FAIL", n, "—", e.message); } };
const ok = (v, m) => { if (!v) throw new Error(m); };
t("identity from /c/<uuid>", () => { const { D, doc } = load('<button aria-label="Send"></button>'); const i = D.identity(doc); ok(i.sessionId === "chatgpt:11111111-1111-4111-8111-111111111111" && i.verified, JSON.stringify(i)); });
t("provisional local id is not verified", () => { const { D, doc } = load('<button aria-label="Send"></button>', "https://chatgpt.com/c/local-chatgpt%3A33333333-3333-4333-8333-333333333333"); ok(!D.identity(doc).verified, "provisional verified"); });
t("project chat identity", () => { const { D, doc } = load('<button aria-label="Send"></button>', "https://chatgpt.com/g/g-p-abc123/c/22222222-2222-4222-8222-222222222222"); const i = D.identity(doc); ok(i.project === "g-p-abc123" && i.verified, JSON.stringify(i)); });
t("sidebar list with project", () => { const { D, doc } = load('<button aria-label="Send"></button>'); const l = D.listSidebar(doc); ok(l.length === 2 && l[1].project === "g-p-abc123" && l[0].current, JSON.stringify(l)); });
t("messages: roles + block-aware text", () => { const { D, doc } = load('<button aria-label="Send"></button>'); const m = D.readMessages(doc); ok(m.length === 2 && m[0].role === "user" && m[1].text === "1\n2\n3" && m[1].messageId === "a-1", JSON.stringify(m)); });
t("status working when Stop present", () => { const { D, doc } = load('<button aria-label="Stop streaming"></button>'); ok(D.status(doc).status === "working", D.status(doc).status); });
t("status idle with Start Voice", () => { const { D, doc } = load('<button aria-label="Start Voice"></button>'); ok(D.status(doc).status === "idle", D.status(doc).status); });
t("duplicate Stop buttons → low confidence (fail closed)", () => { const { D, doc } = load('<button aria-label="Stop"></button><button aria-label="Stop"></button>'); const r = D.resolveButton(doc, D.BTN.stop); ok(r.count === 2 && r.confidence < D.ACTION_MIN_CONF, JSON.stringify({ ...r, el: !!r.el })); });
t("doctor read-write on healthy page", () => { const { D, doc } = load('<button aria-label="Send"></button>'); ok(D.doctor(doc).mode === "read-write", JSON.stringify(D.doctor(doc).checks)); });
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
