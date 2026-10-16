// Builds a SessionCore with the providers enabled in the config. Adapters load lazily so a missing optional
// dependency only disables its own provider.
import { SessionCore } from "@command-center/core/SessionCore.mjs";

export async function buildCore({ config, log = () => {}, owner = `agentd:${process.pid}` }) {
  const enabled = config.providers, providers = {};
  if (config.demo) {   // made-up sessions in every harness; no real account is touched
    const { DemoProvider } = await import("@command-center/demo/demoProvider.mjs");
    const { demoWorld } = await import("@command-center/demo/world.mjs");
    const w = demoWorld();
    for (const p of enabled) providers[p] = new DemoProvider(p, w[p] || []);
    return new SessionCore({ providers, presentation: config.presentation });
  }
  if (enabled.includes("claude-code")) {
    const { ClaudeCodeAdapter } = await import("@command-center/claude-code/ClaudeCodeAdapter.mjs");
    const { ClaudeCodeProvider } = await import("@command-center/claude-code/provider.mjs");
    const { setupClaudeAuth } = await import("@command-center/claude-code/auth.mjs");
    const c = config.claudeCode || {};
    const auth = setupClaudeAuth(c);   // API key from the Keychain unless claudeCode.auth is "login"
    const provider = new ClaudeCodeProvider(new ClaudeCodeAdapter({ owner, log, model: c.model || undefined, settingSources: c.settingSources ?? undefined }));
    if (!auth.ok) provider.start = async () => { throw Object.assign(new Error(auth.error), { code: auth.code }); };   // shows in the system check
    providers["claude-code"] = provider;
  }
  if (enabled.includes("codex")) {
    const { CodexAdapter } = await import("@command-center/codex/CodexAdapter.mjs");
    const { CodexProvider } = await import("@command-center/codex/provider.mjs");
    const c = config.codex || {};
    providers.codex = new CodexProvider(new CodexAdapter({ owner, log, model: c.model || undefined, effort: c.effort || undefined, approvalPolicy: c.approvalPolicy || "on-request" }));
  }
  if (enabled.includes("cowork") || enabled.includes("chatgpt")) {
    // Not part of the open-source version (no supported API for these harnesses): say so instead of crashing.
    const load = (m) => import(m).catch(() => { throw Object.assign(new Error("Cowork and ChatGPT support is not included in this version; remove them from config providers"), { code: "NOT_INCLUDED" }); });
    const { WebBridgeClient, WebBridgeProvider } = await load("@command-center/web-bridge/webBridge.mjs");
    const { DesktopLauncher } = await load("@command-center/desktop-launcher/desktopLauncher.mjs");
    const client = new WebBridgeClient(); client.subscribe();
    if (enabled.includes("cowork")) providers.cowork = new WebBridgeProvider("cowork", client, { launcher: new DesktopLauncher({ log }) });
    if (enabled.includes("chatgpt")) providers.chatgpt = new WebBridgeProvider("chatgpt", client);
  }
  return new SessionCore({ providers, presentation: config.presentation });
}
