// How Claude Code sessions authenticate. "apiKey" (the default): an Anthropic API key from the macOS Keychain,
// which is what Anthropic asks of third-party tools built on the Agent SDK. "login": the Claude Code login already on
// this computer, for personal setups only. The key is put in the daemon's environment for the SDK; never logged.
import { execFileSync } from "node:child_process";

export const DEFAULT_KEYCHAIN_SERVICE = "command-center-anthropic";

export function readKeychain(service) {
  try { return execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

/** @returns {{ok: true, mode: string} | {ok: false, error: string, code: string}} and sets env.ANTHROPIC_API_KEY in apiKey mode */
export function setupClaudeAuth(cfg = {}, { env = process.env, keychain = readKeychain } = {}) {
  const mode = cfg.auth || "apiKey";
  if (mode === "login") return { ok: true, mode };
  if (mode !== "apiKey") return { ok: false, code: "BAD_CONFIG", error: `claudeCode.auth must be "apiKey" or "login", not "${mode}"` };
  if (env.ANTHROPIC_API_KEY) return { ok: true, mode };
  const service = cfg.keychainService || DEFAULT_KEYCHAIN_SERVICE;
  const key = keychain(service);
  if (!key) return { ok: false, code: "NO_API_KEY", error: `no Anthropic API key in the Keychain item "${service}"` };
  env.ANTHROPIC_API_KEY = key;
  return { ok: true, mode };
}
