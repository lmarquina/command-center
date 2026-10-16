# Roadmap

Prototype (reference only): a local prototype kept outside this repo. Its proven logic is ported here with its tests; its
runtime pieces are rebuilt milestone by milestone.

## Ported and tested (first commit)
- `packages/core`: ids, events, locks, attention, capabilities, SessionCore
- `packages/providers/web-bridge`: provider (event-fed lists, steps); `desktop-launcher`: launcher + AX helper source
- `apps/gateway`: voice command parser, fuzzy matching, motion detection, screens, walking screens, view model

## Milestone 1: the stack runs from this repo
- [x] Core daemon + CLI (`agentd`, `agentctl`), Claude Code and Codex adapters
- [x] `extension/` (Chrome bridge + native host) with the handler-presence test (not yet loaded in Chrome from this repo)
- [x] Gateway server: WebSocket endpoint, push notifications, web UI
- [x] `apps/glasses` (Even Hub app; builds, not yet run on the glasses from this repo)
- [x] `services/voice` (runs from this repo: speak + transcribe round trip checked)
- [x] `npm run dev` / `stop` / `status` / `sim` wired; services under a supervisor that restarts them
- [x] Configuration in one file (`config/default.json`, per-machine `config/local.json`)
- [ ] Cut-over: load the extension from `extension/chrome`, re-pair the glasses, retire the prototype

## Done after milestone 1
- [x] Every Cowork project's sessions listed (own background tabs + project pages), system check on the glasses

## Milestone 2: acceptance on the glasses
The prototype's `TEST_RUN.md`, rerun against this repo: pocket mode, walking mode on a real walk, free talk.

## Later
- Start the stack at login (launchd) once it has run unattended for a while.
Windows bridge (Claude Code sessions on the PC), sidebar scrolling for older sessions, reasoning summaries.
