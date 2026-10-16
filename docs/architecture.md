# Architecture

> The open-source version includes the Claude Code and Codex providers. The web bridge (Cowork, ChatGPT) and
> the Claude Desktop launcher shown below belong to the private build; there is no supported API for them yet.

```
G2 glasses ⇄ Even app (phone) ⇄ apps/glasses (thin web app)
                                   ⇅ wss (Tailscale)
                              apps/gateway ── services/voice (STT/TTS, 127.0.0.1)
                                   ⇅ unix socket
                              packages/core (session daemon)
        ┌──────────────┬───────────────┬────────────────────────┐
   claude-code       codex         web-bridge             desktop-launcher
  (Agent SDK)    (App Server)   (Chrome extension →      (macOS Accessibility →
                                claude.ai, chatgpt.com)   Claude Desktop, new Cowork tasks)
```

## Identity
Canonical session id = `<provider>:<native id>`: Claude Code transcript uuid, Codex thread id, Cowork `cse_…`
or `chat:<uuid>`, ChatGPT `<uuid>`. Request id = `<provider>:<native request id>`. Titles are display-only.

## Events (the only way state moves)
Providers emit native events; `packages/core/src/events.mjs` normalizes them:
`sessions.changed`, `session.created|updated`, `status.changed`, `agent.started|output.delta|output.complete|
completed|interrupted|failed`, `approval.requested|approved|denied|cancelled`, `question.requested|answered`.
Event ids are deterministic so replays de-duplicate. The core appends every event to `run/events.jsonl`.

Consumers keep **materialized views** from events (session lists, the attention list) and render from those.
Nothing in a tap/voice path may await a provider call before drawing (stale-while-revalidate).

## Writes
One writer per session: `LockManager` leases a session to a client id (`cli`, `web-ui`, `g2`). A second
writer gets `SESSION_LOCKED` unless it takes over explicitly. Codex also has its own native writer lock.

## Capabilities
`packages/core/src/capabilities.mjs` states what each provider can do (steer, interrupt, approve, structured
questions, create). UI and voice consult it; they never branch on provider names.

## Why no broker
Single user, a few events per second, one machine. An append-only local log plus materialized views gives
the streaming model without Kafka's cost. If a second machine joins (e.g. a Windows bridge), use NATS or
Redis Streams.
