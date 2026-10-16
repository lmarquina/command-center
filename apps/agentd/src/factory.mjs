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
    return new SessionCore({ providers });
  }
  if (enabled.includes("claude-code")) {
    const { ClaudeCodeAdapter } = await import("@command-center/claude-code/ClaudeCodeAdapter.mjs");
    const { ClaudeCodeProvider } = await import("@command-center/claude-code/provider.mjs");
    const c = config.claudeCode || {};
    providers["claude-code"] = new ClaudeCodeProvider(new ClaudeCodeAdapter({ owner, log, model: c.model || undefined, settingSources: c.settingSources ?? undefined }));
  }
  if (enabled.includes("codex")) {
    const { CodexAdapter } = await import("@command-center/codex/CodexAdapter.mjs");
    const { CodexProvider } = await import("@command-center/codex/provider.mjs");
    const c = config.codex || {};
    providers.codex = new CodexProvider(new CodexAdapter({ owner, log, model: c.model || undefined, effort: c.effort || undefined, approvalPolicy: c.approvalPolicy || "on-request" }));
  }
  if (enabled.includes("cowork") || enabled.includes("chatgpt")) {
    const { WebBridgeClient, WebBridgeProvider } = await import("@command-center/web-bridge/webBridge.mjs");
    const { DesktopLauncher } = await import("@command-center/desktop-launcher/desktopLauncher.mjs");
    const client = new WebBridgeClient(); client.subscribe();
    if (enabled.includes("cowork")) providers.cowork = new WebBridgeProvider("cowork", client, { launcher: new DesktopLauncher({ log }) });
    if (enabled.includes("chatgpt")) providers.chatgpt = new WebBridgeProvider("chatgpt", client);
  }
  return new SessionCore({ providers });
}
