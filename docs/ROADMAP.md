# ROADMAP

Eight phases. Each is independently shippable and independently *reversible*. Do not
start a phase until the previous one's Definition of Done is fully green — this project
has a compounding data layer, and a bug in Phase 2 silently poisons every number the site
ever shows.

Estimated effort assumes evenings, not full days.

---

## Phase 0 — Scaffold and decisions
**Goal:** an empty but correctly-shaped repo that deploys a "hello" page to production.
**Effort:** 1 evening

Deliverables:
- npm workspaces monorepo: `packages/core`, `web`, root worker
- TypeScript strict config shared via `tsconfig.base.json`
- `wrangler.jsonc` with assets + D1 + KV + cron bindings (IDs filled after creation)
- Vitest configured for `packages/core`
- ESLint + Prettier, `npm run lint` and `npm run typecheck` both pass
- `docs/DECISIONS.md` seeded with three ADRs: why Workers over Pages, why D1 over KV for
  time series, why we ingest on cron rather than proxying

**Done when:** `npm run deploy` puts a static page on a `*.workers.dev` URL, and CI runs
typecheck + lint + test on every push.

**Why first:** getting the deploy pipeline working while there is nothing to break is far
cheaper than debugging it later alongside real bugs.

---

## Phase 0.5 — Measure before you commit
**Goal:** replace every storage estimate in CLAUDE.md with a number you measured.
**Effort:** 30 minutes

Workers Paid is active, so the CPU question is settled and this is now purely a sizing
exercise. Still worth doing: the tier thresholds and retention windows are all derived
from my estimate of the payload shape, and if that estimate is off by 3x every number
downstream is wrong.

Write a throwaway script that fetches the Hypixel bazaar endpoint once and reports:
- `content-length`, raw and gzipped
- product count, and how many have `buy_summary`/`sell_summary`
- `JSON.parse` wall time (run it 10 times, take the median)
- serialized byte size of one `quick_status` row and one full product with order books
- projected `snapshots`/`hourly`/R2 growth for Tier A and for all products

Then update CLAUDE.md §3 with the real figures and delete this phase.

**Done when:** the numbers in CLAUDE.md are yours, not mine.

**Why bother:** this is also the cheapest possible test that the endpoint behaves the way
this whole plan assumes — keyless, complete, one request.

---

## Phase 1 — Port the domain core
**Goal:** `packages/core` fully implements the Python model, with tests, and zero I/O.
**Effort:** 2–3 evenings

Port in this order (each depends on the last):
1. `sides.ts` — normalize raw points, derive ask/bid structurally
2. `stats.ts` — mean, avg-low, avg-high, floor, ceiling, spread, volatility, flow rates
3. `profile.ts` — hour-of-day bucketing, index vs 24h mean, best contiguous window
4. `economics.ts` — three scenarios, throughput caps, warning flags
5. `recipes.ts` — recipe type, ratio exceptions, verified flag

Required tests:
- **Inversion test** — feed a series with `buy`/`sell` and their min/max/volume/movingWeek
  fields swapped; assert byte-identical `Stats` output. This is the load-bearing test.
- Known-value tests: hand-compute one craft's three scenarios and assert exact numbers
- Edge cases: single data point, zero volume, missing min/max fields, `ask == bid`
- Property test: `ask >= bid` holds for every normalized point, for any input

**Done when:** the inversion test passes, coverage on `packages/core` is >90%, and
`packages/core` has no imports outside itself and `vitest`.

**Why this shape:** the core is the only part of this project worth reusing. Keeping it
free of Cloudflare, fetch, and D1 means the next thing you build — a Discord bot, an alert
daemon, a second site — imports it instead of reimplementing it. This is the same
reusable-systems discipline that makes a multi-project studio work.

---

## Phase 2 — Data layer and ingestion
**Status: deployed and ingesting; 48-hour clock started 2026-08-26 ~03:00 UTC.** Remote D1
migrated, R2 bucket holding real per-tick objects, cron live and steady at 12 ingests/hour.
As of version `795c2c5d`, **all four run kinds report `ok=true, error=null`** — the
`precompute` and double-cron problems that blocked the clock are both resolved, and
`prune` has recorded its first clean production run.

Two Done-when clauses remain open, both on the calendar rather than on anyone's desk:
48 unattended error-free hours (earliest close **2026-08-28 03:00 UTC**) and "pruning has
actually deleted something", which cannot happen until `snapshots` crosses 7 days on
**~2026-09-01**. Today's prune deleted 0 rows correctly — nothing was past retention.

**Goal:** the cron keeps D1 filled with a rolling 30 days of real bazaar history, running
indefinitely without falling over.
**Effort:** 2–3 evenings

**Deploy this standalone the moment it works** — before the API, before any frontend.
History you did not collect is unrecoverable, and by the time Phase 5 is done you will
have three or four weeks of your own five-minute data. That is better than anything
Coflnet would give you for the same window.

Deliverables:
- Migrations for `products`, `recipes`, `snapshots`, `hourly`, `daily`, `runs`
- Tier assignment: a tag is Tier A if referenced by a recipe, **or** in the top ~500 by
  `sellMovingWeek`, **or** the lowest- or highest-level book of an enchant family
  (CLAUDE.md §2). Production carried 501 Tier A tags before the book clause; with it,
  ~784. Config-driven, re-evaluated each run, never a migration
- `ingest.ts`: one fetch, normalize via `packages/core`, tier split, chunked multi-row
  insert. Tier A → `snapshots`; Tier B → `hourly` directly
- Order book depth metrics computed at ingest (depth within 1% and 5% of top of book,
  largest wall, order count). Raw summaries go to R2, never to D1
- R2 archive: one object per tick, full order books 14 days, `quick_status` to 30 days,
  **deleted beyond 30** — the delete is what keeps the archive flat at ~2.3 GB
- `rollup.ts`: hourly, daily, and **30-day retention pruning on every table**. Nothing in
  this system is kept longer than a month (CLAUDE.md §3); `hourly` and `daily` were
  previously "keep indefinitely" and are not any more
- `event.cron` branching in `scheduled`
- Nightly `wrangler d1 info`-equivalent size check recorded into `runs`
 
Watch for:
- Chunk inserts by **bound parameter count** (cap 100/query), not row count
- Deletes count as rows written — budget pruning alongside inserts
- Hypixel occasionally returns a product with missing `quick_status`; skip, don't crash
- One bad product must not abort the whole run
- Ingest must be idempotent — a retry at the same timestamp upserts, never duplicates
- `hourly.samples` must be honest. Do not fabricate a full-sample row from partial data

**Done when:** the cron has run unattended for 48 hours, `runs` shows zero errors, pruning
has actually deleted something, R2 has real objects in it, and you have deliberately
broken the ingest and confirmed `runs` recorded the failure.

**Then leave it running while you build Phase 3 onward.**

---

## Phase 3 — Historical backfill
**Status: deferred by decision, 2026-08-25. Re-scoped 2026-08-26 by the 30-day cap.** Not
skipped for lack of time — deferring is free and delaying Phase 2 is not. Coflnet's
history stays available; our own five-minute history exists only if the cron was running
at the time. So production ingestion went first. `scripts/backfill.ts` is still a stub.
See ADR in `docs/DECISIONS.md`.

**The 30-day cap changed what this phase is for, and bounded it.** Backfilling further
than 30 days is now actively pointless — the next nightly prune deletes it. So the ceiling
is not a judgement call any more, it is 30 days, and the job shrinks accordingly.

What survives is the part that was always the real value: **reaching a full 30-day window
immediately instead of waiting a month for one.** The weekly band needs 7 days to exist at
all and 4 weeks before its hit-rate means anything, so this is the difference between
publishing bands in September and publishing them now.

**Goal:** fill the retention window to its full 30 days, and cross-check our own coverage.
**Effort:** 1 evening

**Scope check before you build this.** Hypixel's `buyMovingWeek`/`sellMovingWeek` are
trailing-seven-day volumes that arrive complete in your very first snapshot. So the entire
throughput model — crafts/day, hours-to-fill, the volume sanity checks that stop the site
recommending dead items — works on day one with zero history.

The **only** thing that genuinely needs accumulated history is hour-of-day price
profiling, which wants 14+ days. If Phase 2 has been running for three weeks by the time
you get here, you may not need this phase at all.

Do it anyway, for one reason: cross-referencing Coflnet against your own rows is how you
detect gaps in your collection. At ~150 tags and one request per tag, it is a 95-second
job. The rate limit is a one-time cost, not an ongoing constraint.

Deliverables:
- `scripts/backfill.ts` — local Node, hits SkyCofl, writes to D1 via the D1 HTTP API or
  `wrangler d1 execute --file`
- Rate limiter: min 1.05s between requests, honors `Retry-After` on 429
- Resumable: records progress so an interrupted run continues instead of restarting
- Writes into `hourly` directly, tagged `source='coflnet'` so it is distinguishable from
  your own data

Watch for:
- SkyCofl coarsens resolution the further back you go; do not assume even spacing
- This script must never end up imported by the Worker. Enforce with an ESLint boundary
  rule if you can be bothered — a comment is not enforcement

**Done when:** every Tier A tag has a full 30 days of `hourly` rows with no gaps, and
re-running the script is a no-op rather than a duplicate. Never request a range older than
30 days — the prune will delete it, so fetching it only spends someone else's rate limit.

---

## Phase 4 — API and precompute
**Status: DONE — deployed and verified 2026-08-25.** All seven endpoints live on version
`59e5b9af`; `npm test` 219 green across 20 files, `npm run typecheck` clean. Verified
against production rather than assumed:

- `precompute` succeeded at 22:07:10 UTC (1256ms, no error) — the first successful run.
  `scan:default:v1` exists in KV at 66,194 bytes and `/api/scan` returns `source: "kv"`
  with 42 scored crafts, replacing the 42× `no-base-data` payload a dev session had left.
- **Warm latency: median 4ms, max 5ms** server-side `wallTime` from observability, against
  the <50ms target. Measured from tail events, not curl wall-clock.
- Parameter validation returns 400 naming the offending parameter on both `/api/scan` and
  `/api/craft/:tag`; `?tax=1.25` no longer returns a confident wrong answer.

**Goal:** fast, cheap, honest endpoints.
**Effort:** 2 evenings

Endpoints:
```
GET /api/scan?tax=&capture=&window=   ranked craft list
GET /api/item/:tag                    stats across 1d/7d/30d
GET /api/item/:tag/history?range=     series for charting
GET /api/item/:tag/hours?days=        hour-of-day profile
GET /api/craft/:baseTag               full three-scenario breakdown
GET /api/recipes                      recipe list with verified flags
GET /api/status                       last ingest, data age, row counts
```

Deliverables:
- `precompute.ts` writes the default-parameter scan to KV each cron; `/api/scan` with
  default params is a single KV read
- Non-default parameters recompute from `hourly` in D1 — parameterized scans are the
  minority of traffic and should not force everything through D1
- Every response carries `meta.generatedAt` and `meta.staleAfter`
- `Cache-Control` set deliberately per route; use the Cache API for history ranges
- `/api/status` is public — data freshness is a feature, not a secret

**Done when:** ~~the default scan responds in <50ms warm~~ (met: 4ms median), and every
endpoint returns a correct `meta` block including during a stale-data window.

---

## Phase 4.5 — Weekly bands and anvil merges
**Goal:** the feature the site is actually for — trailing weekly high/low bands — plus
enchanted-book merging as a second craft type.
**Effort:** 3–4 evenings

Read CLAUDE.md §8's two new subsections before starting. They carry the domain rules; this
section is only the build order.

### Part A — the conversion graph (do this first, both parts need it)

`packages/core/src/convert.ts`. A recipe stops being "base × ratio → product" and becomes
an edge in a graph; what the model wants is the **cheapest path** to one unit of the
output. This single module serves three purposes:

1. Anvil chains, where every intermediate level is itself tradeable and entering at level 3
   is often cheaper than at level 1
2. Tier-2 compaction (`SUGAR_CANE → ENCHANTED_SUGAR → ENCHANTED_SUGAR_CANE`), which is the
   same problem and is currently **wrong in production** — see TODO.md
3. Any future multi-step recipe, without a third implementation

Build it generic over edges. Do not special-case anvils.

### Part B — anvil merges

- `packages/core/src/anvil.ts` — parse `ENCHANTMENT_{ENCHANT}_{LEVEL}` into (family,
  level); derive each family's level range from the product list, never a hardcoded map
- Migration: `recipes` needs a `kind` discriminator (`'compact' | 'anvil'`). The existing
  table is `(base_tag, ench_tag, ratio, verified, note)` with `UNIQUE(base_tag, ench_tag)`,
  which stores an anvil edge fine — `ratio` is 2 — but nothing currently distinguishes the
  two craft types, and they have different UI, different gating, and different fill risk
- Tier assignment gains the book level-endpoint clause (Phase 2 deliverables)
- Seed anvil recipes for every family, all `verified = 0`

### Part C — weekly bands

- `packages/core/src/bands.ts` — trailing-window percentile bands plus hit-rate
- `GET /api/bands/:tag?days=&pLow=&pHigh=` — buy band, sell band, hit counts, week count
- `GET /api/bands` — ranked band scan, the band analogue of `/api/scan`
- Precompute the default band scan to KV alongside the craft scan

**Watch for:**
- Sides. A buy order competes at `bid`, a sell offer at `ask` (CLAUDE.md §1). Building the
  low band from the ask side inverts the whole strategy and is the single most likely bug
  in this phase — write the test that would catch it first
- Percentiles, not `MIN`/`MAX` — a 5-minute wick is not a transactable price
- A band without its hit-rate is not shippable (non-negotiable #6)
- 4 weeks is the *maximum* n the 30-day cap allows for multi-week claims. Report the week
  count; never imply a longer track record
- Anvil ratios are `2^(M-L)`, so an off-by-one in level arithmetic is a 2x cost error, not
  a rounding difference

**Done when:** a band endpoint returns buy/sell bands with hit-rates for any Tier A tag;
the anvil scan ranks merges by profit-per-day with fill feasibility attached; the
cheapest-path solver picks the right entry level on a hand-computed case; and
`ENCHANTED_SUGAR_CANE` no longer reports a 3,000% margin.

---

## Phase 5 — Frontend
**Goal:** the interactive site.
**Effort:** 4–6 evenings, the largest phase

Stack: Vite + React + TypeScript + Tailwind. Charts behind a single `<PriceChart>`
component — start with Recharts for speed of development, and if a 90-day hourly series
(~2,000 points) feels sluggish, swapping to uPlot is then a one-file change. Isolating
the chart library behind your own component is the point; picking the "right" one up front
is not.

Views:
1. **Band table** — the landing view, and the reason the site exists. Per tag: buy band,
   sell band, spread after tax, and the hit-rate for each side. Sortable, filterable by
   capital. This is what someone opens before setting up orders for the evening.
2. **Band detail** — price chart with both bands drawn as horizontal lines over the
   trailing window, so "how often did price touch this" is answered visually rather than
   asserted. Week count stated plainly.
3. **Scan table** — sortable, ranked by profit/day. Columns: craft, profit/craft, margin,
   crafts/day, capital, flags. Filter by capital available. Craft type (compaction vs
   anvil) is a visible column, not an inferred detail.
4. **Craft detail** — three scenarios side by side, price chart with buy/sell windows
   shaded, hour-of-day bar chart, flag explanations in plain language. For anvil merges,
   show the chosen entry level and what the alternatives would have cost.
5. **Item page** — ask/bid history, depth, volume, volatility.
6. **Settings drawer** — tax rate, capture fraction, band percentiles, sleep window,
   timezone. Persist to `localStorage`. These change results a lot, so they must be
   visible, not buried.

Non-negotiable UI rules:
- A margin number never appears without its fill-feasibility number adjacent
- A band never appears without its hit-rate adjacent — same rule, same reason
- Unverified recipes are visually marked. Every anvil recipe starts unverified, so this
  marking is load-bearing on launch rather than a rare edge case
- Data age is always visible, not in a tooltip
- Anything resting on fewer than 4 weeks says so where the number is, not in a footnote
- Mobile works — a lot of this gets checked on a phone next to a game session

**Done when:** Lighthouse performance >90, the site is usable at 375px wide, and someone
who has never seen it can explain what "crafts/day" means from the UI alone.

---

## Phase 6 — Production deploy
**Goal:** `orangecheasy.net` live, deploying from `main`, observable.
**Effort:** 1 evening

Deliverables:
- Custom domain attached to the Worker (Workers → Settings → Domains & Routes)
- GitHub Actions: PR runs typecheck + lint + test; merge to `main` runs migrations then
  deploys. `CLOUDFLARE_API_TOKEN` scoped to Workers Scripts Edit + D1 Edit only
- Preview deploys on PRs via a `preview` Worker environment
- Cloudflare observability enabled; an alert on cron failure
- A rate-limiting rule on `/api/*` so one scraper cannot burn the request budget

**Done when:** a merge to `main` reaches production with no manual step, and you have
deliberately broken a deploy and confirmed CI caught it before production did.

---

## Phase 7 — Earn the traffic
**Goal:** the reasons someone returns tomorrow.
**Effort:** ongoing

Candidates, roughly in value order:
- **Alerts** — "tell me when ENCHANTED_X margin exceeds N". Cloudflare Queues is included
  in the paid plan, and a Discord webhook is the cheapest delivery channel, so the
  infrastructure cost here is zero. This is the single strongest retention feature and the
  main argument for eventually adding accounts. Consider pulling it forward ahead of some
  Phase 5 polish.
- **Recipe verification workflow** — a way to mark ratios confirmed, with a contributor
  credit. Turns your biggest data-quality weakness into community participation.
- **Shareable craft links** — `?tax=&capture=` in the URL so a Discord post reproduces
  exactly what the poster saw.
- ~~**Base-only diurnal view**~~ — **promoted to Phase 4.5** as the weekly band, and it is
  now the site's primary feature rather than a retention candidate. The reasoning that put
  it on this list still holds: it often beats crafting outright, it carries no
  recipe-ratio or collection-gating risk, and no competitor front-pages it.
- **Backtest** — "if you had run this strategy for 30 days, here is what happened."
  Expensive to build, but it is the one thing that turns a calculator into a tool people
  trust — and with a 30-day window it is now *exactly* the span we retain, so a backtest
  is the natural validation of the band strategy rather than a separate data problem.

Deliberately **not** doing: user accounts, a mod, a mobile app, real-money anything.

---

## Phase 8 — Publish the open dataset
**Goal:** the aggregated bazaar history, free and open, as bulk dumps.
**Effort:** 2 evenings, but gated behind a month of proven collection

**Re-scoped 2026-08-26: this is a rolling 30-day window, not an accumulating archive.**
The retention cap (CLAUDE.md §3) means we never hold more than a month, so what gets
published is "the last 30 days, refreshed daily" — a *current* dataset rather than a
historical one. Two consequences worth being honest about up front:

- **We are not the place to get 2024 bazaar history.** Anyone wanting a long series still
  needs Coflnet or their own collector. Say so in the README rather than letting people
  discover it after downloading.
- **Dated files stop being immutable in the useful sense.** A day's file is still frozen
  once written, but it *disappears* 30 days later. The manifest must state the window, and
  consumers who want history have to mirror the dumps themselves. That is a legitimate
  design — it is how a rolling feed works — but it must be documented, not implied.

The upside: publishing a rolling window is a much weaker claim on Hypixel's policy than
mirroring their history forever, which strengthens the position below rather than
weakening it.

**Hard gate: do not ship this until Phase 2 has run clean for 30 days.** A dataset with
unmarked gaps is worse than no dataset, because people build on it and your silent cron
failure becomes their corrupted analysis. With a 30-day window this gate is stricter, not
looser — a 3-day outage is 10% of everything you would be publishing.

### Policy position — settle this before writing code

Hypixel's API policy (developer.hypixel.net/policies) contains three clauses that touch
this. Being free and open source clears one of them:

| Clause | Status |
|---|---|
| No commercial use; features must be available to all users | **Cleared** — free, open, no tiers |
| Not for automated data collection at scale | Live risk. Stated example is player-stat polling; market data is arguably distinct |
| May not proxy the Public API to 3rd party developers | Live risk, mitigated by the design below |

Neither remaining clause is about money, so "it's free" does not resolve them. The
downside is not legal — it is losing API access, which ends the project.

Mitigations, in order of value:
1. **Open-source the collector**, not only the data. "Here is the code, run your own" is
   not proxying under any reading, and the project survives being cut off.
2. **Publish aggregates, not a mirror.** Hourly OHLC with volume and sample counts is a
   compilation we built. Re-emitting raw `quick_status` verbatim every 5 minutes is much
   closer to fronting their endpoint. Same underlying data, very different character.
3. **Ask Hypixel directly.** One paragraph via the developer portal. A yes is worth more
   than any amount of inference.

### Deliverables

- Public R2 bucket on `data.orangecheasy.net`. **Dumps, not a query API** — R2 has zero
  egress fees, so a static dated file costs nothing regardless of who downloads it, while
  a public query endpoint means unbounded D1 row reads driven by strangers' bad bots.
- One **Parquet** file per day. DuckDB and pandas load it directly, so the whole window is
  queryable on someone's laptop without touching our infrastructure at all.
- `manifest.json` — available dumps, schema version, date coverage, **and the retention
  window stated explicitly** so a consumer knows files expire rather than discovering it
  when a link 404s. Prune published dumps on the same 30-day schedule as everything else.
- **Coverage report shipped alongside every dump**: per-tag hour counts, `samples`
  distribution, and an explicit list of known gaps. Non-negotiable; see §3b.
- `Cache-Control: immutable` on dated files; short TTL on the manifest only
- Schema versioning. Once published, a column's meaning is frozen. Add columns, never
  repurpose them.
- LICENSE for the compilation (CC-BY-4.0 is the low-friction choice), plus a clear notice
  that the underlying data originates from Hypixel and that this project is not affiliated
  with or endorsed by Hypixel or Mojang.

**Done when:** someone who has never spoken to you can find the manifest, download the
window, load it in DuckDB, correctly identify which hours are low-confidence, and
correctly understand that files older than 30 days are gone — without asking you anything.

**Why this is worth doing:** Coflnet rate-limits and BazaarTracker paywalls the key.
Nobody publishes bulk dumps. This is the exact problem that made this project annoying to
start, and fixing it for the next person is cheap once the collection exists.

---

## Cost expectations

| Item | Cost |
|---|---|
| Workers Paid | already active |
| D1 | within paid inclusions with large headroom at Tier A volume |
| KV | within inclusions |
| R2 | within 10 GB free **only if** the archive policy in CLAUDE.md §3 is followed |
| Queues | within inclusions; unlocks Phase 7 alerts |
| Domain | already owned |

Marginal cost of this project is effectively zero. The binding constraint is no longer
money or platform limits — it is evening-hours and the discipline to not widen scope
just because the headroom exists.

If $5/mo is a blocker: move ingestion to a GitHub Actions cron writing to D1 over HTTP,
and keep the Worker on free. Real tradeoff — scheduled Actions run late by 5–20 minutes,
get disabled after 60 days of repo inactivity, and split your logic across two runtimes.
Worth it only if the $5 genuinely isn't available.
