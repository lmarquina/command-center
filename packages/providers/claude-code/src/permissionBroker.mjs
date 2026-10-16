// Turns the SDK's canUseTool callback into first-class, externally decidable ApprovalRequest objects.
// The callback's promise stays pending until an external client calls decide(); nothing is auto-approved.
// AskUserQuestion arrives through the same callback and becomes kind:"question"; it is answered with
// { behavior:"allow", updatedInput:{...input, answers:{[questionText]: label}} } (SDK contract).

export class PermissionBroker {
  constructor({ onOpen, onClose } = {}) {
    this.pending = new Map(); // requestId -> { request, resolve, input }
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
  }

  /** Factory for Options.canUseTool bound to one session. */
  callbackFor(sessionId) {
    return (toolName, input, opts) => new Promise((resolve) => {
      const requestId = opts.requestId || opts.toolUseID;
      const isQuestion = toolName === "AskUserQuestion";
      const request = {
        requestId, sessionId, provider: "claude-code",
        kind: isQuestion ? "question" : "tool",
        tool: toolName, toolUseId: opts.toolUseID,
        description: opts.title || (isQuestion ? (input.questions || []).map((q) => q.question).join(" / ") : `${opts.displayName || toolName}: ${opts.description || summarize(toolName, input)}`),
        question: isQuestion ? (input.questions || []).map((q) => ({ text: q.question, header: q.header, multiSelect: !!q.multiSelect, options: (q.options || []).map((o) => o.label) })) : undefined,
        details: { input, decisionReason: opts.decisionReason, blockedPath: opts.blockedPath, displayName: opts.displayName, agentId: opts.agentID },
        createdAt: new Date().toISOString(),
      };
      const entry = { request, resolve, input };
      this.pending.set(requestId, entry);
      // The CLI aborts the request if the turn ends/interrupts; surface that as "cancelled".
      opts.signal?.addEventListener("abort", () => this.#close(requestId, "cancelled", { behavior: "deny", message: "Request cancelled." }), { once: true });
      this.onOpen(request);
    });
  }

  list(sessionId) { return [...this.pending.values()].map((e) => e.request).filter((r) => !sessionId || r.sessionId === sessionId); }
  get(requestId) { return this.pending.get(requestId)?.request; }

  /**
   * @param {"approve"|"deny"} decision
   * @param {{answers?: Record<string,string>, message?: string}} [opts]
   */
  decide(requestId, decision, opts = {}) {
    const e = this.pending.get(requestId);
    if (!e) throw Object.assign(new Error(`no pending request ${requestId}`), { code: "NO_SUCH_REQUEST" });
    if (decision !== "approve" && decision !== "deny") throw Object.assign(new Error(`bad decision ${decision}`), { code: "BAD_DECISION" });
    let result;
    if (decision === "deny") result = { behavior: "deny", message: opts.message || "The user denied this action." };
    else if (e.request.kind === "question") {
      const answers = normalizeAnswers(e.request.question, opts.answers);
      result = { behavior: "allow", updatedInput: { ...e.input, answers } };
    } else result = { behavior: "allow", updatedInput: e.input };
    this.#close(requestId, e.request.kind === "question" && decision === "approve" ? "answered" : decision, result);
    return e.request;
  }

  #close(requestId, decision, result) {
    const e = this.pending.get(requestId);
    if (!e) return;
    this.pending.delete(requestId);
    e.resolve(result);
    this.onClose(e.request, decision);
  }
}

// Answers must use the exact question text as key and an exact option label as value (or free text).
function normalizeAnswers(questions, answers = {}) {
  const out = {};
  for (const q of questions || []) {
    const given = answers[q.text] ?? answers[q.header] ?? (questions.length === 1 ? Object.values(answers)[0] : undefined);
    if (given === undefined) throw Object.assign(new Error(`no answer for question "${q.text}"`), { code: "MISSING_ANSWER" });
    const exact = q.options.find((o) => o.toLowerCase() === String(given).toLowerCase());
    out[q.text] = exact || String(given);
  }
  return out;
}

function summarize(tool, input) {
  if (input.command) return String(input.command).slice(0, 200);
  if (input.file_path) return String(input.file_path);
  return JSON.stringify(input).slice(0, 200);
}
