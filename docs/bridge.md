# Web bridge (Chrome extension)

Drives claude.ai (Cowork) and chatgpt.com in the user's own Chrome through content scripts. There is no public
API for either; this is UI automation and can break when those sites change. Everything fails closed.

## Page contract: claude.ai
- Sidebar rows: `[data-row-key]` = `cowork:cse_…` | `chat:<uuid>` | `project:<uuid>` | `label:…`
- Row status labels (`aria-label`): `Running` → working, `Awaiting input` → waiting_for_input,
  `Unread response` → complete
- Sessions inside a collapsed (pinned) project are NOT rows: after `Toggle sessions for <project>` they appear
  as plain links inside the project block. Read them by expanding, reading, collapsing again.
- Messages: `[role="article"][aria-label^="Message "]`; assistant `[data-testid="assistant-message"]` with
  `data-turn-key`. A reply still being written may lack the "Message N of M" label: include trailing ones.
- Step groups: `[data-cds="TurnStatus"]`; steps `[data-cds="TurnStatusStep"]` with stable `data-step-key`;
  a step's details live in its `aria-controls` panel.
- Identity: highlighted sidebar row, or (when there is none) URL id + real page title + rendered conversation.

## Page contract: chatgpt.com
- Chat id from `/c/<uuid>`; composer is a ProseMirror editor. `execCommand("insertText")` can silently do
  nothing in a long-hidden tab: fall back to writing the paragraph and dispatching `input`, then verify.

## Tabs
- The extension keeps its own pinned background tab per site (marked with `window.name = "cc-bridge"`, so it is
  found again after a restart and recreated if closed). All background work happens there. A session is only
  acted on in one of the user's tabs if that tab already shows it.
- Only the extension's tab publishes the session list and expands sidebar projects.
- One queue per site in the service worker: user actions, then reads, then the project inventory.

## Every project's sessions
The sidebar shows recent rows and a few pinned projects. `/projects` lists every project and each
`/project/<id>` page lists its sessions (cards: an empty link over the card, name in the link's `aria-label`;
"Show more" loads older ones). The extension reads them all at start-up, every 15 minutes and on
`session.inventory`, and merges them into the list.

## Rules
- Hidden tabs throttle timers to ~1/min. Wait on `MutationObserver`, never on polling timers.
- One UI lane per tab: page-changing work is serialized; user actions (send/approve/answer/stop) before
  step reads before background project reads.
- Push `session.listChanged` when the sidebar changes; lists are served from that, not fetched per request.
- Extension reload orphans content scripts and wipes their memory. Never depend on in-memory state surviving.
- A test must fail if any RPC handler the service worker forwards to is missing from the content script.
