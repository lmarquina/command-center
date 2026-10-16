// What has to be true for every harness to work, as a list of checks: { id, ok, label }. Labels are written for
// the glasses: short, and saying what to do when something is wrong. Pure; the inputs are gathered by agentd.

/**
 * @param {object} o
 * @param {object} o.providers   start-up result per provider: { ok, error?, code? }
 * @param {object|Error} [o.bridge] bridge.health result from the Chrome extension, or the error reaching it
 * @param {boolean} o.desktopRunning  Claude Desktop is running (only it can start Cowork tasks on this computer)
 */
export function healthChecks({ providers = {}, bridge, desktopRunning }) {
  const checks = [];
  const web = ["cowork", "chatgpt"].filter((p) => providers[p]);
  if (web.length) {
    if (!bridge || bridge instanceof Error) checks.push({ id: "chrome", ok: false, label: "Chrome extension not connected: open Chrome" });
    else {
      checks.push({ id: "chrome", ok: true, label: `Chrome extension ${bridge.extension || ""}`.trim() });
      const site = { cowork: "claude.ai", chatgpt: "chatgpt.com" };
      const name = { cowork: "Cowork", chatgpt: "ChatGPT" };
      for (const p of web) {
        const h = bridge[p] || {};
        checks.push(h.tab !== "ok" ? { id: p, ok: false, label: `${name[p]}: can't open ${site[p]} in Chrome` }
          : !h.signedIn ? { id: p, ok: false, label: `${name[p]}: signed out of ${site[p]}` }
          : { id: p, ok: true, label: `${name[p]}: connected` });
      }
    }
  }
  if (providers.cowork) checks.push(desktopRunning ? { id: "desktop", ok: true, label: "Claude Desktop running" } : { id: "desktop", ok: false, label: "Claude Desktop closed: new Cowork tasks can't start" });
  for (const [p, name] of [["claude-code", "Claude Code"], ["codex", "Codex"]]) {
    if (!providers[p]) continue;
    checks.push(providers[p].ok ? { id: p, ok: true, label: `${name}: connected` } : { id: p, ok: false, label: `${name}: ${providers[p].error || "not available"}`.slice(0, 60) });
  }
  return checks;
}
