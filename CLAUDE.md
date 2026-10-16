# Command Center

Control AI agent sessions (Claude Code, Codex, Cowork, ChatGPT) from Even Realities G2 glasses,
a phone, and earbuds, without touching the laptop. Single user, runs on the owner's Mac.

## Layout
- `packages/core`: unified session layer: ids, events, locks, attention list. No provider logic leaks out of here.
- `apps/agentd`: the daemon that hosts the core + providers on a local socket, and its CLI
- `config/default.json`: all settings; `config/local.json` (gitignored) overrides per machine
- `packages/providers/*`: one adapter per harness (claude-code, codex, web-bridge, desktop-launcher)
- `extension/`: Chrome extension that drives claude.ai and chatgpt.com (the "bridge")
- `apps/gateway`: glasses + web gateway, voice commands, screens, push notifications
- `apps/glasses`: thin Even Hub app. Renders what the gateway sends; no business logic.
- `services/voice`: Python STT/TTS service (local MLX models + OpenAI fallback)
- `docs/`: read the relevant file before working in that area (see Docs below)

## Commands
- `npm test`: all unit tests. Run before saying anything is done.
- `npm test -w <workspace>`: one workspace; prefer this while iterating
- `npm run agentd`: start the session daemon · `npm run agentctl -- sessions|attention|get <id>|…`: talk to it
- `npm run voice:setup` once, then `npm run voice`: the speech service · `npm run test:voice`: its tests
- `npm run gateway`: web UI on http://127.0.0.1:3000 and the glasses endpoint (needs the daemon running)
- `npm run bridge -- doctor|sessions|read <id>|…`: talk to the Chrome extension directly (debugging)
- `npm run dev` / `stop` / `status`: run the whole stack in the background, supervised (logs in `run/logs/`)
- `npm run login-item -- install|remove`: start the stack at login (launchd owns it while installed)
- `npm run sim`: glasses simulator on a running stack; screenshots at `GET http://127.0.0.1:9898/api/screenshot/glasses`,
  input at `POST /api/input {"action":"click"|"down"|…}`. This is how to verify screen changes.
- `npm run build:ax -w @command-center/desktop-launcher`: build the macOS Accessibility helper
- Node 22 via `.nvmrc` (the Even CLI needs ≥ 20). Python via `uv`, project-local.

## Architecture rules (each one came from a real bug)
- Identity is always the harness's own id (session id, `cse_…`, thread id, chat uuid). Never a title.
- One writer per session, enforced by the core's lease. Reads stay concurrent.
- Push, don't poll: state reaches screens through events and cached views. A screen must never
  wait on a provider call to draw. Draw from what we know, fetch in the background, repaint.
- Fail closed: if identity, a page structure, or an approval target is uncertain, do nothing and say so.
- No LLM decides what runs. Voice commands are rule-based + fuzzy; actions need confirmation.
- Provider differences are expressed through the capabilities table, not `if (provider === …)`.
- The glasses app stays thin. Screen logic lives in the gateway as pure functions with tests.

## Gotchas
- Chrome throttles timers in hidden tabs to ~1/min. In the extension, wait on DOM mutations, not `setTimeout`.
- Reloading the extension orphans content scripts and wipes their in-memory state. Don't rely on either.
- Only one page-changing action per browser tab at a time (the UI lane); user actions go first.
- The glasses font drops unsupported glyphs silently. Text goes through the font filter; list items ≤ 63 bytes.
- iOS mutes web-view audio when the phone is locked or the ringer is off. Locked-phone replies go by push.

## How we work
- Before coding: state assumptions; if a request has two readings, ask instead of picking one.
- Smallest change that solves it. No speculative options, abstractions, or error handling for cases that can't happen.
- Touch only what the task needs. Mention unrelated problems; don't fix them unasked.
- Turn the task into a check first (a test, a simulator screenshot, a log line), then loop until it passes.
  A bug fix starts with a test that reproduces it.
- Don't turn test-setup limitations into product requirements. Design for how it is actually used.
- Never report something as working unless you ran it. Say what was verified and what was not.
- Two repos: work happens in the private one; `npm run publish` (dry run) / `-- --push` sends a scanned, clean copy of
  `main` to the public one. Never commit or merge on the public repo; take public PRs in as described in `docs/ops.md`.
- Commit small, on a branch, with messages that say why. Never commit secrets, tokens, or `run/` state.

## Hard limits
- IMPORTANT: never click consent, permission, or "another app" dialogs in Claude Desktop, macOS, or Chrome.
  Stop and report them.
- Test only in sandbox sessions and folders. Don't send messages to, or modify, real work sessions.
- Secrets live in the macOS Keychain. Never print them or write them to files.

## Docs (read on demand)
- `docs/architecture.md`: event flow, the lease, capability table
- `docs/bridge.md`: claude.ai / chatgpt.com page contracts and selectors
- `docs/glasses.md`: Even Hub limits, screens, walking mode, voice commands
- `docs/voice.md`: STT/TTS engines, routing, per-harness voices
- `docs/ops.md`: start-up, remote access, pocket-mode notifications, known failures
- `docs/roadmap.md`: what is ported, what each milestone adds
