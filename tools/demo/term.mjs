// Runs a real terminal program (Claude Code, Codex) in a pseudo-terminal and renders it with xterm.js in a
// headless browser page, so the demo shows the program's own interface without opening windows on the screen.
import path from "node:path";
import pty from "node-pty";

const XTERM = path.join(path.dirname(new URL(import.meta.url).pathname), "../../node_modules/@xterm/xterm");

export async function openTerminal(browser, { cmd, args = [], cwd, cols = 104, rows = 34, env = {}, fontSize = 15, cropBottom = 0 }) {
  const page = await browser.newPage({ viewport: { width: Math.ceil(cols * fontSize * 0.61) + 24, height: Math.ceil(rows * fontSize * 1.6) + 1000 }, colorScheme: "dark" });
  await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="file://${XTERM}/css/xterm.css"><style>html,body{margin:0;background:#141716;padding:12px;overflow:hidden} img{display:none}</style></head><body><div id="t"></div></body></html>`);
  await page.addScriptTag({ path: path.join(XTERM, "lib/xterm.js") });
  await page.evaluate(({ cols, rows, fontSize }) => {
    window.term = new Terminal({ cols, rows, fontSize, fontFamily: "Menlo, monospace", theme: { background: "#141716", foreground: "#e6e6e6" }, allowProposedApi: true });
    window.term.open(document.getElementById("t"));
  }, { cols, rows, fontSize });
  // A clean environment: nothing inherited from whatever started the recorder (e.g. an agent session's markers).
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|CLAUDECODE|CODEX|ANTHROPIC|OPENAI|TERM_PROGRAM|ITERM|VSCODE)/.test(k)));
  const proc = pty.spawn(cmd, args, { name: "xterm-256color", cols, rows, cwd, env: { ...base, TERM: "xterm-256color", COLORTERM: "truecolor", ...env } });
  let pending = "", output = "", last = null;
  proc.onData((d) => { pending += d; output += d; });
  const flush = async () => { if (!pending) return; const d = pending; pending = ""; await page.evaluate((x) => new Promise((r) => window.term.write(x, r)), d); };
  const api = {
    page, proc,
    output: () => output,
    write: (s) => proc.write(s),
    // the terminal element itself, wherever the page laid it out
    async screenshot() {
      await flush();
      try {
        const b = await page.locator(".xterm-screen").boundingBox({ timeout: 2000 }), rowH = b.height / rows;
        // skip the first two rows: start-up terminal queries leave stray characters there
        last = await page.screenshot({ type: "jpeg", quality: 90, clip: { x: b.x, y: b.y + 2 * rowH, width: b.width, height: b.height - (2 + cropBottom) * rowH } });
      } catch (e) { if (!last) throw e; }   // mid-redraw: keep the previous frame
      return last;
    },
    async close() { try { proc.kill(); } catch {} await page.close(); },
    /** Resolves once the terminal has laid out and a capture works (a fresh page can't be captured yet). */
    async ready(timeoutMs = 15000) {
      const end = Date.now() + timeoutMs;
      for (;;) { try { await api.screenshot(); return api; } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 300)); } }
    },
  };
  return api;
}
