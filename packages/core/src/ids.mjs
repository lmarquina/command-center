// Canonical, provider-prefixed identities. Titles are never identity.
//   claude-code:<uuid>        Claude Code transcript id
//   codex:<uuidv7>            Codex thread id
//   cowork:cse_<id>           Cowork session (or cowork:chat:<uuid> for chat-kind claude.ai sessions)
//   chatgpt:<uuid>            chatgpt.com conversation id
export const PROVIDERS = ["claude-code", "codex", "cowork", "chatgpt"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseSessionId(id) {
  const s = String(id || "");
  const i = s.indexOf(":");
  if (i < 0) throw Object.assign(new Error(`not a canonical session id (missing provider prefix): ${s}`), { code: "BAD_SESSION_ID" });
  const provider = s.slice(0, i), native = s.slice(i + 1);
  if (!PROVIDERS.includes(provider)) throw Object.assign(new Error(`unknown provider ${provider}`), { code: "BAD_SESSION_ID" });
  const ok = provider === "cowork" ? /^(cse_[A-Za-z0-9]+|chat:[0-9a-f-]{36})$/.test(native) : UUID.test(native);
  if (!ok) throw Object.assign(new Error(`malformed ${provider} id: ${native}`), { code: "BAD_SESSION_ID" });
  return { provider, native, id: s };
}

export function sessionIdFor(provider, native) {
  if (provider === "chatgpt" && native.startsWith("chatgpt:")) native = native.slice(8); // bridge already prefixes
  return parseSessionId(`${provider}:${native}`).id;
}

/** The id the provider's own transport expects. */
export function nativeIdForTransport({ provider, native }) {
  return provider === "chatgpt" ? `chatgpt:${native}` : native;
}

// Request ids (approvals/questions) are namespaced the same way so approve(requestId) can be routed.
export const requestIdFor = (provider, nativeRequestId) => `${provider}:${nativeRequestId}`;
export function parseRequestId(rid) {
  const s = String(rid || ""); const i = s.indexOf(":");
  const provider = s.slice(0, i);
  if (i < 0 || !PROVIDERS.includes(provider)) throw Object.assign(new Error(`bad request id ${s}`), { code: "BAD_REQUEST_ID" });
  return { provider, native: s.slice(i + 1) };
}
