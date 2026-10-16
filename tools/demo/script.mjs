// The demo, step by step. `say` is spoken to the glasses (typed into the same path as speech); `ms` is how long the
// result stays on screen; `clip` groups scenes into short standalone clips; `what` is the caption under the spoken words. Title cards have no glasses or computer.
export const SCRIPT = [
  { title: { h: 'Your AI agents,<br>on your glasses<span class="dot">.</span>', p: "Claude Code, Codex, Cowork and ChatGPT, run from Even Realities G2 by voice. Everything runs on your own Mac." }, ms: 4500 },
  { clip: "1-whats-running", what: "Home: what needs you, what's running, and the latest sessions from every harness.", ms: 5000 },
  { say: "What's running?", what: "Everything working right now, across all four harnesses.", clip: "1-whats-running", ms: 6500 },
  { say: "Open Cowork", what: "One harness at a time. Live status first, then the most recent.", clip: "1-whats-running", ms: 6000 },
  { say: "New task in Strategy: draft talking points for the board meeting", what: "Start a Cowork task in a project. Anything that acts asks first.", clip: "2-start-a-task", ms: 5000 },
  { say: "Do it", what: "The task starts on the Mac and shows up everywhere at once.", clip: "2-start-a-task", ms: 7000 },
  { say: "What needs me?", what: "One list of everything waiting on you.", clip: "3-approve-from-glasses", ms: 5500 },
  { say: "Next", what: "Go through them one by one: here, Codex wants to run a command.", clip: "3-approve-from-glasses", ms: 6000 },
  { say: "Approve", what: "Approvals need the word “approve”. A stray “yes” never runs anything.", clip: "3-approve-from-glasses", ms: 4500 },
  { say: "Approve", what: "Approved from the glasses; Codex carries on.", clip: "3-approve-from-glasses", ms: 7000 },
  { say: "Open refactor auth middleware", what: "Open any session by name. It opens where you left off.", clip: "4-talk-to-claude-code", ms: 6000 },
  { say: "Also run the test suite", what: "Talk to the agent: your words go straight into the session.", clip: "4-talk-to-claude-code", ms: 4500 },
  { say: "Send it", what: "Claude Code picks it up and replies on the glasses.", clip: "4-talk-to-claude-code", ms: 8000 },
  { say: "Home", what: "", clip: "5-ask-chatgpt", ms: 3000 },
  { say: "When was Lincoln born?", what: "From home, anything else is a quick question for ChatGPT.", clip: "5-ask-chatgpt", ms: 4500 },
  { say: "Yes", what: "The answer appears on the glasses and is read aloud.", clip: "5-ask-chatgpt", ms: 8000 },
  { title: { h: 'Built for walking around<span class="dot">.</span>', p: "Voice first, glanceable screens, push to talk or hands-free, big text while walking. Open source: github.com/lmarquina/command-center" }, ms: 5000 },
];
