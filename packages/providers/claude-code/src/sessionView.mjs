// Normalizes SDK session-store records (listSessions / getSessionMessages) into provider-neutral views.

export function toSummary(info, live) {
  return {
    provider: "claude-code",
    sessionId: info.sessionId,
    title: info.customTitle || info.summary || info.firstPrompt || "(untitled)",
    cwd: info.cwd,
    gitBranch: info.gitBranch,
    createdAt: info.createdAt ? new Date(info.createdAt).toISOString() : undefined,
    updatedAt: info.lastModified ? new Date(info.lastModified).toISOString() : undefined,
    tag: info.tag,
    status: live ? live.status : "idle",
    live: !!live,
  };
}

/** SessionMessage[] (getSessionMessages) → SessionMessageView[] */
export function toMessageViews(msgs) {
  const out = [];
  for (const m of msgs) {
    const content = m.message && m.message.content;
    if (m.type === "user") {
      if (typeof content === "string") { out.push({ id: m.uuid, role: "user", text: content }); continue; }
      for (const c of content || []) {
        if (c.type === "text") out.push({ id: m.uuid, role: "user", text: c.text });
        else if (c.type === "tool_result") {
          const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("") : "";
          out.push({ id: m.uuid, role: "tool", toolResult: { toolUseId: c.tool_use_id, isError: !!c.is_error, preview: text.slice(0, 200) } });
        }
      }
    } else if (m.type === "assistant") {
      for (const c of content || []) {
        if (c.type === "text" && c.text) out.push({ id: m.uuid, role: "assistant", text: c.text });
        else if (c.type === "tool_use") out.push({ id: m.uuid, role: "assistant", tool: { name: c.name, id: c.id, input: c.input } });
      }
    } else if (m.type === "system") {
      out.push({ id: m.uuid, role: "system", text: typeof content === "string" ? content.slice(0, 200) : undefined });
    }
  }
  return out;
}

export function matchesQuery(summary, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return [summary.sessionId, summary.title, summary.cwd, summary.gitBranch, summary.tag].some((v) => v && String(v).toLowerCase().includes(s));
}
