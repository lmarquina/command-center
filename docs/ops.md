# Operations

## Running it
`npm run dev` starts every service listed in `config.stack.services` under a supervisor (in the background) and
keeps the computer awake while it runs. Logs: `run/logs/<service>.log`; supervisor log: `run/logs/stack.log`.
`npm run status` shows what is up and how often each service restarted; `npm run stop` ends everything.

**Start at login:** `npm run login-item -- install` adds a per-user LaunchAgent (`com.commandcenter.stack`) that
runs the supervisor and restarts it if it dies. While it is installed, `npm run dev` starts it through launchd and
`npm run stop` unloads it (it stays stopped until the next login or `npm run dev`). Remove with
`npm run login-item -- remove`. On battery, macOS may postpone restarting a killed supervisor ("pended nondemand
spawn = inefficient"); the supervisor itself still restarts crashed services immediately, and a new supervisor first
stops any services its predecessor left running. Tailscale has its own "launch at login" setting in its app.

## Remote access
The phone reaches the Mac through Tailscale; the gateway serves `wss://` and the glasses app `https://` with a
Tailscale certificate (`tailscale cert`). Machine-specific network notes live in `CLAUDE.local.md`.

## Spoken replies and iOS
- Web-view audio plays only while the Even app is on screen and the ringer is on.
- When the phone reports its page hidden, replies are sent as Web Push to the "Command Center" home-screen
  web app instead (payload end-to-end encrypted; Siri can announce them).

## Starting new Cowork tasks on the Mac
Only Claude Desktop binds a task to this Mac. The launcher drives Desktop through macOS Accessibility: New →
optional project (matched by stable id) → exact prompt read-back → Start. It never clicks consent dialogs
and reports `CONSENT_REQUIRED` instead. `claude://` deep links are not used (prefill only + a per-launch
confirmation).

## Known operational facts
- Codex Desktop holds the writer lock for any thread it has open.
- Chrome and Claude Desktop must be running; the Mac must stay awake (`caffeinate` while on power).
- Background jobs started from an agent session can be killed at its time limit: run services under a
  process manager (milestone 1), not from a session.

## Publishing (private → public)
- Settings live in `config/local.json` → `publish`: the public repo name, the personal terms to block, and
  paths to leave out. That file is never published.
- `npm run publish` exports what is committed on `main`, scans every file and shows what would change. Any hit
  (personal term, Tailscale name, private address, email, home path, key) stops it with file and line.
- `npm run publish -- --push` makes one commit on the public repo (`--create` the first time only).

## Taking in a public pull request
1. Read it on GitHub. Nothing is ever merged there.
2. In the private repo: `git switch -c contrib/pr-<n>` then `gh pr diff <n> --repo <public repo> | git apply`.
3. Run the tests; commit with `Co-authored-by: <their name> <their GitHub noreply email>` so they keep credit.
4. Open and merge a private PR as usual, then `npm run publish -- --push`.
5. Close the public PR with a comment that it is included in the latest update.

