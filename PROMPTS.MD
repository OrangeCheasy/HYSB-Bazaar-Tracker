# PROMPTS.md

Copy-paste prompts for Claude Code, one per phase. `CLAUDE.md` loads automatically, so
these deliberately do **not** repeat the architecture — restating it wastes context and
invites contradictions between two sources of truth.

Prompts for phases 0, 0.5, 1, 2, 4 and 4.5 have been deleted — that work is built, deployed
and verified in production. What remains below is what has not been built.

## How to run these well

- **One phase per session.** Start a fresh session between phases; `/clear` when a phase
  is done. Long sessions accumulate stale context and the model starts optimizing for
  things you fixed an hour ago.
- **Ask for a plan first on the big phases** (5, 6). Read the plan, correct it, _then_
  say build. Correcting a plan costs one message; correcting an implementation costs an
  evening.
- **Commit at every checkpoint.** These prompts mark them. A checkpoint you can revert to
  is what makes aggressive delegation safe.
- **Run the tests yourself.** Don't take "tests pass" on faith — ask for the actual output.
- After each phase, ask Claude to append an ADR to `docs/DECISIONS.md` for anything
  non-obvious it decided. Future you will not remember why.

---

## Phase 3 — Backfill

**Deliberately deferred, not forgotten** (2026-08-25). **Re-scoped by the 30-day retention
cap** (2026-08-26): backfilling past 30 days is now pointless, because the nightly prune
deletes it. The job is bounded at exactly one month.

What it is now for: reaching a **full 30-day window immediately** rather than waiting a
month for one to accumulate. The weekly band needs 7 days to exist and 4 weeks before its
hit-rate means anything, so this is the difference between shipping bands now and shipping
them in late September.

`scripts/backfill.ts` is still the 38-line stub that prints "not implemented". Deferring
costs nothing structurally: `hourly.source` already exists and defaults to `'hypixel'`, so
coflnet rows drop in later with no migration.

```
Build scripts/backfill.ts per docs/ROADMAP.md Phase 3.

Two jobs, and the second is the one I actually care about: seed hour-of-day
history for tags that lack it, AND cross-reference Coflnet's rows against
our own to find gaps in our collection. Report any hour where we have no
row but Coflnet does.

Local Node script only — this must never be importable from the Worker.
It reads recipe tags from D1, pulls SkyCofl history for each, and writes
into hourly with source='coflnet'.

Never request a range older than 30 days. Our retention cap prunes it on
the next nightly run, so fetching it only spends someone else's rate limit
for data we immediately delete. Cap --days at 30 and reject higher values
with a message saying why.

Requirements:
- Minimum 1.05s between requests, honoring Retry-After on 429. SkyCofl
  enforces 30/10s and 100/60s in parallel; bursting gets the IP blacklisted.
- Resumable: persist progress to a local file so an interrupted run
  continues rather than restarting.
- Re-running a completed backfill must be a no-op, not a duplicate.
- Coflnet coarsens resolution the further back you go. Don't assume evenly
  spaced buckets.
- --tag and --days flags, plus a --dry-run that reports what it would fetch
  and how long it would take.

Print an ETA before starting. At 1 req/sec and ~90 tags this is a multi-
minute run and I want to know that before it starts.
```

**Checkpoint:** dry-run first, always. Then run for real and spot-check a few tags.

---

## Phase 5 — Frontend

Split this across sessions — one view per session. Don't ask for the whole SPA at once;
the output gets long, quality drops, and reviewing 2,000 lines of unfamiliar React in one
sitting is how bugs get merged.

Session 5a — shell:

```
Set up the Vite + React + TS + Tailwind app in web/ with routing, the
settings drawer (tax, capture, band percentiles, sleep window, timezone —
persisted to localStorage), a typed API client, and the layout shell
including the footer with the SkyCofl attribution link and the
not-affiliated-with-Hypixel disclaimer required by CLAUDE.md section 7.

Before building: propose a visual direction in a sentence or two. This is a
data-dense trading tool, so I want dense tables that stay readable, not a
marketing landing page. Dark by default.

No views yet — just the shell, routing, and a data-age indicator in the
header.
```

Session 5b — band table (the landing view):

```
Build the band table view and make it the landing route. Per tag: buy band,
sell band, spread after tax, and the hit-rate for each side. Sortable,
filterable by available capital.

This is the view someone opens before setting up orders for the evening, so
optimise for scanning a lot of rows quickly, not for explaining one row.

Non-negotiable from CLAUDE.md: a band never renders without its hit-rate
adjacent. Not in a tooltip — adjacent. A band nobody's order ever touches
is not a trade, and the hit-rate is the only thing on the row that says so.

Anything resting on fewer than 4 weeks of data shows the week count inline.

Handle loading and empty states properly, and make it work at 375px wide.
Show me how you're handling the mobile table layout before you build it —
horizontally scrolling tables are usually the wrong answer.
```

Session 5c — scan table:

```
Build the craft scan table view. Sortable, ranked by profit/day by default,
filterable by available capital. Craft type (compaction vs anvil) is a
visible column.

Two rules from CLAUDE.md that are non-negotiable in the UI:
- A margin number never renders without its fill-feasibility number
  adjacent. Not in a tooltip — adjacent.
- Unverified recipes are visually marked. Every anvil recipe ships
  unverified, so this marking is load-bearing on launch, not a rare case.

Reuse the table primitives from the band view rather than building a second
table implementation.
```

Session 5d — detail views + charts:

```
Build the band detail and craft detail views.

Band detail: the price chart over the trailing window with both bands drawn
as horizontal lines, so "how often did price actually touch this" is
answered visually instead of asserted. State the week count plainly.

Craft detail: three scenarios side by side, a price chart with the buy and
sell windows shaded, an hour-of-day bar chart, and plain-language
explanations of any warning flags. For anvil merges, show the chosen entry
level and what the alternatives would have cost — the entry-level choice is
the whole point of the solver and it should be visible, not implicit.

Put the chart behind a single <PriceChart> component with our own props, so
the charting library is swappable in one file. Use Recharts for now.

The flag explanations matter more than the chart. "deep buy-order queue"
means nothing to a user — write the sentence that explains what they should
actually do about it.
```

**Checkpoint per session:** builds, typechecks, works at 375px.

---

## Phase 6 — Deploy

```
Set up production deployment per docs/ROADMAP.md Phase 6.

GitHub Actions: PRs run typecheck + lint + test. Merge to main runs D1
migrations, then deploys. Add a preview Worker environment for PRs.

Tell me the exact minimum Cloudflare API token scopes needed — I want least
privilege, not the "Edit Cloudflare Workers" template.

Then give me a numbered manual checklist for the parts I have to do in the
dashboard: attaching orangecheasy.net to the Worker, enabling observability,
setting up the cron failure alert, and the rate-limiting rule on /api/*.

Finally, tell me how to verify the rollback path works before I need it.
```

**Checkpoint:** deliberately break a test, push, confirm CI blocks the deploy. Then fix it.

---

## Phase 7 — Retention features

```
Read docs/ROADMAP.md Phase 7. I want to build [FEATURE].

Before implementing: what does this force us to add that we don't have
today (queues, auth, storage, a delivery channel)? What's the ongoing
maintenance cost, not the build cost? And is there a version that gets 80%
of the value without the new dependency?

If the honest answer is that this isn't worth it yet, say so.
```

---

## Prompts worth reusing at any point

**Before a risky change:**

```
Before you change anything: what could this break that isn't obviously
related? Check whether packages/core has behaviour depending on this.
```

**When a number looks wrong:**

```
The scan is showing [X] for [craft] and I think it's wrong. Trace the value
backwards from the API response through economics to the raw snapshot rows.
Show me the intermediate values at each step rather than guessing at the
cause.
```

**Periodic hygiene, roughly monthly:**

```
Review the repo against CLAUDE.md. Where has the actual code drifted from
the stated rules? Particularly: has anything leaked into packages/core that
shouldn't be there, and does any route handler contain business logic?

Also flag anything in CLAUDE.md that's now stale and should be updated or
deleted. It should stay under 400 lines.
```
