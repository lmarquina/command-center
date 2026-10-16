// A small, fictional world for demos and screenshots: sessions in every harness, none of them real.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

export function demoWorld() {
  return {
    "claude-code": [
      { id: uuid(101), title: "Refactor auth middleware", status: "working", updatedAt: ago(1), messages: [
        ["user", "Split the auth middleware into token parsing and session lookup, keep the tests green."],
        ["assistant", "Reading src/middleware/auth.ts and its tests. I'll extract parseToken() first, then move the session lookup behind an interface."]] },
      { id: uuid(102), title: "Add dark mode to settings page", status: "idle", updatedAt: ago(95), messages: [
        ["user", "Add a dark mode toggle to the settings page that follows the system setting by default."],
        ["assistant", "Done: added a three-way toggle (System / Light / Dark), stored in user preferences. All 48 tests pass."]] },
      { id: uuid(103), title: "Fix flaky checkout test", status: "complete", updatedAt: ago(30), messages: [
        ["user", "The checkout test fails about one run in ten. Find out why."],
        ["assistant", "The test raced the price recalculation. It now waits for the total to settle. 200 runs in a row passed."]] },
    ],
    codex: [
      { id: uuid(201), title: "Migrate API to v2 endpoints", status: "approval_required", updatedAt: ago(2), messages: [
        ["user", "Move every client call from /api/v1 to /api/v2 and run the migration check."],
        ["assistant", "14 call sites updated. I need to run the migration dry run next."]],
        request: { id: "exec-demo-1", text: "Run: npm run migrate -- --dry-run" } },
      { id: uuid(202), title: "Write unit tests for the CSV parser", status: "idle", updatedAt: ago(240), messages: [
        ["user", "Cover quoted fields, empty lines and Windows line endings."],
        ["assistant", "Added 12 tests; found and fixed one bug with trailing commas."]] },
    ],
    cowork: [
      { id: "cse_01DemoBoardDeckOutline", title: "Q3 board deck outline", project: "Strategy", status: "working", updatedAt: ago(3), messages: [
        ["user", "Draft the outline for the Q3 board deck from the notes in this folder."],
        ["assistant", "Pulling the KPIs from the planning sheet and grouping the notes into five sections."]] },
      { id: "cse_01DemoCompetitiveMemo", title: "Competitive landscape memo", project: "Strategy", status: "idle", updatedAt: ago(180), messages: [
        ["user", "Summarize the three competitor reports into a two-page memo."],
        ["assistant", "Memo saved as competitive-landscape.docx: pricing, positioning, and three open questions."]] },
      { id: "cse_01DemoNewsletterDraft", title: "Weekly newsletter draft", project: "Newsletter", status: "complete", updatedAt: ago(45), messages: [
        ["user", "Write this week's newsletter from the links I saved."],
        ["assistant", "Draft ready: five stories, 600 words, saved next to last week's issue."]] },
      { id: "cse_01DemoTravelReceipts", title: "Organize travel receipts", status: "idle", updatedAt: ago(1500), messages: [
        ["user", "Rename the receipt PDFs by date and vendor and total them by trip."],
        ["assistant", "Renamed 23 files; three trips, totals in receipts-summary.xlsx."]] },
    ],
    chatgpt: [
      { id: uuid(401), title: "Trip ideas for Lisbon", status: "idle", updatedAt: ago(60), messages: [
        ["user", "Three-day Lisbon plan, not too touristy?"],
        ["assistant", "Day 1 Alfama and a fado dinner, day 2 LX Factory and Belém by bike, day 3 a train to Sintra early before the crowds."]] },
      { id: uuid(402), title: "Sourdough starter tips", status: "idle", updatedAt: ago(600), messages: [
        ["user", "My starter smells like nail polish. Is it dead?"],
        ["assistant", "It's hungry, not dead. Feed it twice a day at a 1:1:1 ratio for a few days."]] },
      { id: uuid(403), title: "Explain vector databases", status: "idle", updatedAt: ago(2000), messages: [
        ["user", "Explain vector databases like I'm a product manager."],
        ["assistant", "They store meaning as numbers, so you can search by similarity instead of exact words."]] },
    ],
  };
}

/** Canned answers for questions asked during a demo; anything else gets a short generic reply. */
export function demoAnswer(question) {
  const q = String(question || "").toLowerCase();
  if (/lincoln/.test(q)) return "Abraham Lincoln was born on February 12, 1809, in Hodgenville, Kentucky.";
  if (/weather|rain/.test(q)) return "Expect light rain this afternoon, clearing by evening. Around 17 degrees.";
  if (/capital/.test(q)) return "The capital of Portugal is Lisbon.";
  if (/coffee|caffeine/.test(q)) return "About 400 mg of caffeine a day is considered safe for most adults, roughly four cups of brewed coffee.";
  return "Here's the short version: it depends on the context, but the usual answer is yes, with a couple of caveats.";
}

/** What a new task or a follow-up message turns into. */
export function demoReply(message) {
  const m = String(message || "").toLowerCase();
  if (/test/.test(m)) return "Ran the test suite: 212 passed, 0 failed.";
  if (/deck|slide/.test(m)) return "Outline drafted: 6 slides, speaker notes included. Saved in the project folder.";
  if (/summar|memo|notes/.test(m)) return "Summary ready: one page, five key points, two open questions.";
  return "On it. I'll report back here when it's done.";
}
