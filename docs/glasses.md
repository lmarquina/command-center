# Glasses (Even Realities G2)

Even Hub web app running inside the Even phone app. Foreground-only; apps cannot push to the glasses.

## Display limits
- 576×288, one colour (16 levels). Per page: ≤ 8 text/list containers + ≤ 4 image containers, exactly one
  event-capture container.
- Lists: ≤ 20 items, ≤ 63 bytes each, no in-place update (changing a list rebuilds the page).
- Text: ≤ 1000 chars at rebuild; flicker-free updates with `textContainerUpgrade`; brightness 0–4; borders.
- Images: ≤ 288×144, PNG accepted, sent after the page exists, one at a time (~100 ms each).
- Font: fixed, proportional, drops unknown glyphs. Supported extras include `● ○ ■ □ ▲ ▶ ▷ ◁ ★ ━ ─ █▇▆▅▄▃▂▁`
  and Latin-1 accents. All text passes through the font filter in `apps/gateway/src/screens.mjs`.

## Input
Tap, double-tap (back; exits the app on the root page), swipe, hold. **Left-temple hold belongs to Even's
system menu**: push-to-talk listens on the right temple and the ring only. Releases can get lost; any new
hold or tap must end a stuck recording.

## Screens (pure functions: state + data → page)
Home (3 most relevant sessions, counts, one row per harness), lists with paging, session (opens at the
newest content), request card, steps → group → step detail, confirm, help.
Draw first, fetch after: a session opens instantly with what is known and fills in.

## Voice
Rule-based parser with fuzzy matching (`voiceCommands.mjs`, `fuzzy.mjs`): navigation runs directly; anything
that sends, approves, or creates needs a confirm (tap, or a spoken answer; approvals need the word "approve").
Matching runs in layers: core commands (whole phrase, every screen) → the rows on screen ("open <title>",
"the second one") → for "open …", the rest of that harness's list, then every session ("open ChatGPT <title>"
narrows it) → only then the fallback: outside a session, free speech becomes a ChatGPT question. A failed "open …"
says so and never becomes a question. Titles on screen are also sent to speech-to-text as vocabulary hints.
Every spoken command is logged to `run/voice-eval.jsonl` with the screen it was said on, the result and the time
each stage took (speech-to-text, interpreting, until the screen updated). Free talk = the same without holding; the phone
does voice detection and only passes the wearer's own voice.

## System check
"system check" (or a tap on the warning row) opens a list of every moving part: Chrome extension, sign-in on
claude.ai and chatgpt.com, Claude Desktop, Claude Code, Codex, voice service. Home shows one warning row only
when a check fails. Checks come from agentd (`health`) plus the gateway's voice check, cached and refreshed in
the background.

## Walking mode
IMU (g units, 10 Hz) → `motion.mjs` detects rhythmic steps with hysteresis. While walking, pages are big type
rendered on the phone as four 288×144 image tiles, a few words at a time; details go to audio.
