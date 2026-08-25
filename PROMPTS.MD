# PROMPTS.md

Copy-paste prompts for Claude Code, one per phase. `CLAUDE.md` loads automatically, so
these deliberately do **not** repeat the architecture — restating it wastes context and
invites contradictions between two sources of truth.

## How to run these well

- **One phase per session.** Start a fresh session between phases; `/clear` when a phase
  is done. Long sessions accumulate stale context and the model starts optimizing for
  things you fixed an hour ago.
- **Ask for a plan first on the big phases** (1, 2, 5). Read the plan, correct it, *then*
  say build. Correcting a plan costs one message; correcting an implementation costs an
  evening.
- **Commit at every checkpoint.** These prompts mark them. A checkpoint you can revert to
  is what makes aggressive delegation safe.
- **Run the tests yourself.** Don't take "tests pass" on faith — ask for the actual output.
- After each phase, ask Claude to append an ADR to `docs/DECISIONS.md` for anything
  non-obvious it decided. Future you will not remember why.

---

## Phase 0 — Scaffold

```
Set up the repo scaffold described in docs/ROADMAP.md Phase 0.

npm workspaces monorepo: packages/core, web, and a root Cloudflare Worker.
TypeScript strict everywhere with a shared tsconfig.base.json, including
noUncheckedIndexedAccess. Vitest for packages/core. ESLint + Prettier.

Create wrangler.jsonc with: static assets from dist/client with
not_found_handling single-page-application and run_worker_first for /api/*,
a D1 binding named DB, a KV binding named CACHE, and cron triggers. Leave
database_id and KV id as clearly-marked placeholders — I'll create the
resources and fill them in.

Add a GitHub Actions workflow that runs typecheck, lint, and test on push
and PR. Do not add a deploy workflow yet.

Give me the exact wrangler CLI commands to create the D1 database and KV
namespace, in the order I should run them.

Before writing anything, show me the file tree you plan to create.
```

**Checkpoint:** `npm run typecheck && npm run lint && npm test` all pass. Commit.

---

## Phase 0.5 — Measure the payload

```
Write a throwaway Node script (scripts/spike-measure.ts, delete it after) that
fetches https://api.hypixel.net/v2/skyblock/bazaar once and reports:

- content-length raw and gzipped
- product count, and how many include buy_summary / sell_summary
- median JSON.parse wall time over 10 runs
- serialized byte size of a single quick_status row, and of one full
  product including order books
- projected snapshots / hourly / R2 growth per day, month and year, for
  Tier A (~150 recipe tags) and for all products

Print it as a table. Then update the sizing figures in CLAUDE.md section 3
with the measured numbers and tell me which of my estimates were wrong and
by how much.

If median parse time is anywhere near 10ms, say so explicitly — that's the
number deciding whether Workers Paid is genuinely required.
```

**Checkpoint:** CLAUDE.md now contains your numbers, not estimates. Delete the script.

---

## Phase 1 — Domain core

Run this in two prompts. The first is planning only.

First: copy the Python tool into the repo at `reference/bzcraft/` and commit it.
Claude Code can only read files inside the working directory, so the port
prompt below depends on those files being there. Keep them after the port —
they're your independent check when a number looks wrong six months from now.

```
Read reference/bzcraft/model.py — the Python implementation we're porting.
reference/bzcraft/bzcraft.py shows how it's called end to end, and
README.md explains the market model behind it.

Plan the port to packages/core as five modules: sides, stats, profile,
economics, recipes. For each, give me the exported types and function
signatures only — no implementations yet.

Pay particular attention to how you'll represent the ask/bid derivation
described in CLAUDE.md section 1, and where the seam is between "normalize
raw upstream shape" and "compute over normalized points". Those must be
separate so we can feed the same stats code from Hypixel, from Coflnet, and
from our own D1 rows without three code paths.

Flag anything in the Python that you think is wrong or that won't translate
cleanly. I'd rather fix a modelling mistake now than port it faithfully.
```

Then, after reviewing:

```
Implement the plan. Write tests first for each module, then the
implementation.

Required tests, non-negotiable:
- test/sides.test.ts: build a normal series, then a second series with buy
  and sell swapped along with their min/max/Volume/MovingWeek counterparts.
  Assert the resulting Stats objects are deeply equal. Comment it clearly as
  a load-bearing regression test.
- Property test: every normalized point satisfies ask >= bid, for arbitrary
  input including degenerate cases.
- Hand-computed known-value tests for all three economics scenarios. Show me
  the arithmetic in a comment so I can verify it independently.
- Edge cases: single point, zero volume, missing min/max, ask == bid.

packages/core must import nothing outside itself and vitest. No fetch, no
node:, no cloudflare:.

Run the tests and show me the real output.
```

**Checkpoint:** inversion test green, >90% coverage. Commit. This is the most important
commit in the project.

---

## Phase 2 — Ingestion

```
Build Phase 2 from docs/ROADMAP.md: D1 schema, ingest, rollup, pruning.

Start with the migrations. Show me the schema before implementing anything
against it — include your index choices and the reasoning, since query
patterns are (a) latest snapshot for all tags, (b) hourly series for one tag
over a range, (c) hour-of-day aggregation for one tag over N days.

Then ingest.ts: one fetch to Hypixel's bazaar endpoint, normalize through
packages/core, chunked multi-row insert into snapshots.

Constraints that will break this if ignored:
- D1 caps bound parameters at 100 per query. Chunk by parameter count, not
  row count.
- A product with a missing quick_status must be skipped, not fatal.
- Ingest must be idempotent — a retry at the same timestamp upserts.
- Record every run in a runs table: ts, products seen, rows written,
  duration ms, error text.

Implement the tier split from CLAUDE.md section 2: Tier A (tags referenced
by a recipe) gets 5-minute snapshots; Tier B gets an hourly row only, no
snapshots. Tier membership is derived from the recipes table each run — it
must never require a migration to change.

Order books: compute depth metrics at ingest (depth within 1% and 5% of top
of book, largest single wall, order count) and store only those in D1. The
raw buy_summary/sell_summary go to R2 under the archive policy in CLAUDE.md
section 3 — one object per DAY, not per run.

Then rollup.ts: snapshots→hourly, hourly→daily, and retention pruning per
tier. Branch on event.cron in the scheduled handler.

Integrity requirements, per CLAUDE.md section 3b — these matter more than
the storage math because gaps are unrecoverable:
- every run writes to runs, success or failure
- hourly.samples must reflect actual snapshot count; never fabricate a
  full-sample row from partial data
- the nightly cron records current database size into runs so growth is
  measured over time

Write a local test that runs ingest against a saved fixture of the Hypixel
response so we're not hitting the live API in tests. Save the fixture to
test/fixtures/ — reuse the response from the Phase 0.5 spike.
```

**Checkpoint:** run `npx wrangler dev --test-scheduled` and hit the scheduled endpoint;
inspect local D1 with `wrangler d1 execute bazaar --local --command "select * from runs"`.
Then deliberately break the ingest and confirm `runs` records the failure.

**Then deploy it and leave it running.** Don't wait until the site is built — every day of
delay is a day of history you can't get back. Come back to Phase 3 in a week or three
while it quietly accumulates.

---

## Phase 3 — Backfill

First ask whether you still need this — see the scope check in ROADMAP Phase 3. If the
Phase 2 cron has been running three weeks, hour-of-day profiling may already work.

```
Build scripts/backfill.ts per docs/ROADMAP.md Phase 3.

Two jobs, and the second is the one I actually care about: seed hour-of-day
history for tags that lack it, AND cross-reference Coflnet's rows against
our own to find gaps in our collection. Report any hour where we have no
row but Coflnet does.

Local Node script only — this must never be importable from the Worker.
It reads recipe tags from D1, pulls SkyCofl history for each, and writes
into hourly with source='coflnet'.

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

## Phase 4 — API

```
Build the API layer per docs/ROADMAP.md Phase 4.

Route handlers stay thin — all math comes from packages/core, all SQL from
src/worker/db/. A handler that contains a formula is a bug.

precompute.ts writes the default-parameter scan to KV on each rollup cron.
/api/scan with default params is then a single KV read. Non-default
parameters recompute from hourly in D1.

Every response is { data, meta: { generatedAt, staleAfter, source } }. Set
Cache-Control deliberately per route and tell me your reasoning for each.

/api/status exposes last ingest time, data age, and row counts. Public.

Add a test per endpoint covering the stale-data case — I want to see that
meta is still correct when the cron hasn't run recently.
```

**Checkpoint:** `curl` every endpoint. Confirm `/api/scan` is fast and `meta` is honest.

---

## Phase 5 — Frontend

Split this across sessions — one view per session. Don't ask for the whole SPA at once;
the output gets long, quality drops, and reviewing 2,000 lines of unfamiliar React in one
sitting is how bugs get merged.

Session 5a — shell:
```
Set up the Vite + React + TS + Tailwind app in web/ with routing, the
settings drawer (tax, capture, sleep window, timezone — persisted to
localStorage), a typed API client, and the layout shell including the footer
with the SkyCofl attribution link and the not-affiliated-with-Hypixel
disclaimer required by CLAUDE.md section 7.

Before building: propose a visual direction in a sentence or two. This is a
data-dense trading tool, so I want dense tables that stay readable, not a
marketing landing page. Dark by default.

No views yet — just the shell, routing, and a data-age indicator in the
header.
```

Session 5b — scan table:
```
Build the scan table view. Sortable, ranked by profit/day by default,
filterable by available capital.

Two rules from CLAUDE.md that are non-negotiable in the UI:
- A margin number never renders without its fill-feasibility number
  adjacent. Not in a tooltip — adjacent.
- Unverified recipes are visually marked.

Handle the loading and empty states properly, and make it work at 375px
wide. Show me how you're handling the mobile table layout before you build
it — horizontally scrolling tables are usually the wrong answer.
```

Session 5c — craft detail + charts:
```
Build the craft detail view: three scenarios side by side, a price chart
with the buy and sell windows shaded, an hour-of-day bar chart, and plain-
language explanations of any warning flags.

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
