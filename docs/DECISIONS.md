# Decisions

One short entry per non-obvious choice. Append; don't rewrite history. If a decision is
reversed, add a new entry that supersedes the old one rather than editing it.

---

## ADR-001 — Workers, not Pages

**Date:** 2026-08-24 · **Status:** accepted

Static assets, the API, and the cron jobs all ship as one Worker with one deploy.

Pages would mean splitting the cron ingestion into a separate Worker anyway, since Pages
Functions have no scheduled trigger. That gives two deploys, two configs, and a binding
seam between the thing that writes the data and the thing that reads it. Workers with
`assets` does the whole job in one artifact, and `run_worker_first: ["/api/*"]` keeps
asset serving off the Worker's CPU budget entirely.

**Cost:** we own the SPA fallback routing ourselves (`not_found_handling`), which Pages
would have handled by convention.

---

## ADR-002 — D1 for the time series, KV only for precomputed payloads

**Date:** 2026-08-24 · **Status:** accepted

The core question this site answers — "when during the day is this craft cheapest?" —
is an aggregate over a time range. That is a `GROUP BY`, and KV cannot do it. KV has no
range scans, no aggregation, and no secondary indexes; modelling hour-of-day buckets in
it would mean reimplementing an index by hand in application code.

KV earns its place on the other side of the pipeline: cron computes the scan payload and
writes it once, and every homepage request is a single ~5ms read instead of a query
fan-out. Writes stay on the cron path because KV is write-limited and eventually
consistent (~60s propagation).

**Cost:** D1's per-invocation query limits (1000 on paid) shape how ingestion and pruning
must be written — batched, chunked by bound-parameter count, never a loop.

---

## ADR-003 — Cron ingestion, never proxying upstream on user requests

**Date:** 2026-08-24 · **Status:** accepted

`api.hypixel.net/v2/skyblock/bazaar` returns every product — around 1500 of them — in a
single unauthenticated call. That one property is what makes this project cheap: a
`*/5` cron builds our own history database, and user traffic never leaves our edge.

Three reasons this is a hard rule rather than a preference, in order of severity:

1. Worker subrequests originate from Cloudflare's **shared** IP pool. SkyCofl rate-limits
   by IP. Proxying user traffic through it risks a blacklist that harms other people's
   projects, not just ours.
2. A KV read is ~5ms; an upstream fetch is 200–800ms.
3. Proxying makes our uptime a function of theirs.

**Cost:** data is up to 5 minutes stale, and every API response has to say so — hence the
`meta.generatedAt` / `meta.staleAfter` envelope on every payload.

---

## ADR-004 — Structural ask/bid derivation instead of trusting field names

**Date:** 2026-08-24 · **Status:** accepted

Hypixel's `buyPrice` is what _you pay to instant-buy_ — the lowest sell offer. The names
read backwards, and third-party tools get it wrong constantly.

`packages/core/src/sides.ts` never reads the names as truth. It sorts the two sides by
price and assigns `ask` to the higher and `bid` to the lower, because a crossed book would
have matched already. Volume and moving-week figures follow their own side.

The degenerate `ask === bid` case has no price signal to sort on, so the comparator falls
through to volume, then moving-week. Without that fallback, a tied book would produce
different output depending on which upstream field the numbers arrived in — precisely the
class of bug this module exists to eliminate.

`packages/core/test/sides.test.ts` feeds deliberately inverted input and asserts identical
output. **That test is load-bearing and must not be deleted or weakened.** If it goes red,
the site would print backwards profit numbers, and CI blocks the deploy.

---

## ADR-005 — Two normalized shapes: `Point` for an instant, `Bar` for an interval

**Date:** 2026-08-24 · **Status:** accepted

`snapshots` holds instantaneous ask/bid. `hourly` and `daily` hold `ask_avg/min/max` per
side. A single normalized type cannot represent both without discarding the extremes —
and the extremes are exactly what `askFloor`/`askCeiling` in `Stats` report.

So `packages/core/src/sides.ts` exports both. `Point` is one moment; `Bar` is one interval
carrying per-side low/avg/high plus a `samples` count. A `Point` widens to a degenerate
`Bar` where min == avg == max, which is the truthful reading of a single observation.
Everything downstream of `sides.ts` — `stats`, `profile`, `economics` — consumes `Bar[]`
only.

The payoff is one code path regardless of origin. Hypixel `quick_status`, Coflnet history,
and both D1 row shapes each get a small adapter, and none of them leaks past this module.
Adding a fourth upstream later means writing a fourth adapter, not a fourth branch through
the statistics.

**Cost:** two types to keep straight, and `avgLow` versus `floor` is a distinction readers
have to learn. The alternative was three parallel implementations of the same maths.

---

## ADR-006 — Derive sides at ingest; assert, never re-derive, when reading D1

**Date:** 2026-08-24 · **Status:** accepted · **Extends:** ADR-004

The structural derivation from ADR-004 runs in exactly two places: `normalizeQuickStatus`
and `normalizeCoflnetPoint` — the two upstream adapters. D1 already stores derived sides,
so `normalizeHourlyRow` and `normalizeSnapshotRow` map column names and then _assert_ the
invariant via `isBarWellFormed` / `isWellFormed`.

Re-deriving on read was tempting and is wrong. A crossed row in D1 means ingest wrote bad
data. Silently re-sorting it on the way out repairs the symptom on every page load while
the corrupt rows accumulate, and the bug is then invisible until someone queries the table
by hand. Failing the read surfaces it.

`isBarWellFormed` deliberately does **not** require `askMin >= bidMax`. Over an hour the
ask can dip below where the bid peaked without any single instant having a crossed book;
requiring it would reject legitimate volatile hours.

---

## ADR-007 — Fill feasibility ships with every margin, as a required field

**Date:** 2026-08-24 · **Status:** accepted

CLAUDE.md section 7.5 says a profit figure never appears without its fill-feasibility
caveat. That is a UI rule, and UI rules get forgotten. `ScenarioResult.fillFeasibility` is
therefore non-optional in the type, so a scenario cannot be constructed without one and a
component destructuring a scenario has the number in scope already.

The model: a resting order's chance of filling is the daily flow that hits its side,
against the queue already ahead of it plus the size being added —
`flow / (queueAhead + myUnits)`, clamped to 1. Instant-buy and instant-sell are 1.0 by
definition. The `orders` scenario multiplies both, because both must fill.

The three scenarios then read as a deliberate trade: profit rises from `instant` to
`orders` while feasibility falls. Showing either column alone is a lie in one direction or
the other.

**Cost:** the formula is a plausible model, not a measurement. It has no notion of how
many other players are running the same craft. Treat it as an ordering signal, not a
probability.

---

## ADR-008 — Whether an instant-sell is taxed is a config flag, not a constant

**Date:** 2026-08-24 · **Status:** accepted

CLAUDE.md section 8 states the bazaar sell tax "applies to sell offers only, never to
buying." That reads most naturally as a sell-versus-buy contrast, but it can also be read
as offer-versus-instant, and the two readings produce different numbers for the `instant`
and `mixed` scenarios — the two we present as conservative.

Rather than bury a guess in the arithmetic, `MarketConfig.taxOnInstantSell` defaults to
`true` (the conservative reading: everything you sell is taxed) and can be flipped in one
place. Both readings are covered by tests with the arithmetic written out.

**Supersede this entry** once the mechanic is confirmed in-game, rather than editing it.

---

## ADR-009 — Flow rates are an estimate derived from trailing-week counters

**Date:** 2026-08-24 · **Status:** accepted

`Stats.ibPerDay` and `isPerDay` are `mean(movingWeek) / 7`. The upstream figures are
rolling seven-day totals, so averaging them across bars is smoothed by construction: this
is an estimate of daily flow, not a measurement of it.

It matters because these two numbers are the denominator of every throughput cap and of
fill feasibility, so an error here scales straight through to profit-per-day — the value
the whole scan is ranked by.

The alternative is differencing consecutive counters to recover per-interval flow. That is
more direct but noisier, since each difference is "units traded in this interval minus
units traded in the same interval seven days ago", and it needs an unbroken series to work
at all. Revisit once Phase 2 has produced enough continuous history to compare the two.

---

## ADR-010 — Unreachable defensive branches are structured out, not tested around

**Date:** 2026-08-24 · **Status:** accepted

`packages/core` had branch coverage stuck below the ROADMAP's 90% bar, entirely from
`?? 0` fallbacks that existed to satisfy `noUncheckedIndexedAccess` and could never fire —
`mean()` of an array already proven non-empty, indexing a fixed-length array at a bounded
index.

Two ways out: lower the threshold, or remove the impossible branches. We removed them.
`computeStats` accumulates in a single pass instead of fifteen `map` + `mean` calls;
`computeHourProfile` buckets into a `Map` whose `get` has two genuinely reachable
outcomes; window search accumulates a running sum instead of building an array and taking
its mean.

The result is honest coverage rather than a lowered bar, and two incidental wins: one pass
over the series instead of fifteen, and no more `Math.min(...bars.map(f))` spreading every
element onto the call stack — harmless at 2,000 bars, a crash waiting for whoever widens
the retention window.

The branch threshold now sits at 90 to match the goal. What remains uncovered is a small
number of non-finite guards, which are cheap insurance against a NaN arriving from a bad
upstream payload.

---

## ADR-011 — The third scenario is time-aware, not a half-order hybrid

**Date:** 2026-08-24 · **Status:** accepted · **Supersedes the scenario set in ADR-007**

`packages/core` was first written before `bzcraft/model.py` was available, and guessed a
third scenario of "buy order on the base, instant-sell the product". The Python's actual
third scenario is **time-aware**: the same orders on both sides, but priced from the cheap
hour window for the base and the dear hour window for the product.

The guess was not merely different, it was off-premise. The diurnal edge is the reason
this project exists — CLAUDE.md's opening line is "tracks base to enchanted craft margins,
**diurnal price patterns**, and volume-adjusted profitability" — and a scenario set with no
time dimension cannot express it. The scan would have ranked on a number that ignored the
site's whole thesis.

The set is now `floor` / `orders` / `timed`, matching `craft_economics`:

|          | base price         | product price     | note                                 |
| -------- | ------------------ | ----------------- | ------------------------------------ |
| `floor`  | `lastAsk`          | `lastBid`         | instant both ways, always achievable |
| `orders` | `lastBid + tick`   | `lastAsk - tick`  | current book, both orders must fill  |
| `timed`  | cheap-window price | dear-window price | the headline; falls back to `orders` |

`profitPerDay` ranks on `timed`, per the Python's `profit_per_day = crafts_per_day *
timed_profit`.

Window prices are passed in by the caller rather than computed here, so `economics` stays
independent of `profile` — the same seam the Python uses via its `timed_buy_price` and
`timed_sell_price` arguments.

**Also adopted from the Python in the same pass:** the `tick`, i.e. the coins-per-unit you
outbid or undercut by. Without it the model priced your order _at_ the current best, which
puts you behind everyone already resting there while assuming you fill like the best order
in the book.

---

## ADR-012 — Hour windows score on partial data, and say so

**Date:** 2026-08-24 · **Status:** accepted

`bestContiguousWindow` originally required every hour in a window to be populated. On
Coflnet backfill that returns nothing at all: their history coarsens with age, so a 30-day
pull legitimately leaves half the hour slots empty, and Phase 3 seeds exactly that data.

Following `model.py best_window`, a window now scores if at least half its hours have
data, averaged over the hours actually present. The obvious risk is that a window scored
on two hours competes on equal footing with one scored on six, so `HourWindow.hoursPresent`
travels with the result and the UI marks a thin window rather than presenting it as solid.

The hour baseline changed in the same pass, also to match the Python: it is the mean of the
**populated hourly means**, not the mean of the raw bars. One vote per hour, so a densely
sampled hour cannot drag the baseline toward its own price and make every other hour look
mispriced — again a real effect on unevenly-sampled backfill data.

---

## ADR-013 — Flow rates come from the newest counter, not an average

**Date:** 2026-08-24 · **Status:** accepted · **Supersedes ADR-009**

ADR-009 derived `ibPerDay` / `isPerDay` as `mean(movingWeek) / 7` and flagged
counter-differencing as the likely better alternative. `model.py` does neither: it takes
the **last** point's counter, `last.instant_buy_week / 168`.

That is correct and both alternatives were worse. The upstream figure is already a rolling
seven-day total, so the newest reading is the best available estimate of current weekly
flow. Averaging it across bars averages a series of overlapping stale windows and lags the
market; differencing recovers per-interval flow but is noisy and needs an unbroken series.

Book depth moved to the last bar for the same reason — a queue is a thing that exists right
now, not on average. `Stats` therefore exposes `lastAsk`, `lastBid`, `lastAskDepth`,
`lastBidDepth`, and the economics reads those rather than the window means. The means are
kept for charting and for the typical-price fields.

Two smaller alignments in the same pass: `volatility` is now measured on the **ask** rather
than the mid, because the ask is what you pay to instant-buy and what your sell offer
competes against; and `spreadPct` is `(askMean - bidMean) / askMean`, the Python's
denominator. Both stay unitless — percentage formatting belongs at the display layer.

---

## ADR-014 — The timed buy is priced from the sleep window, not the cheapest window

**Date:** 2026-08-24 · **Status:** accepted · **Corrects ADR-011**

ADR-011 landed the time-aware scenario but sourced its buy price from `bestBuyWindow`,
the cheapest contiguous hours. `bzcraft.py` line 207 does something different:

```python
overnight_bid = mean_over_hours(base_cells, sleep_hours, "bid_mean") or base_stats.last_bid
timed_buy_price = overnight_bid + config["tick"]
```

The price comes from the **sleep window** — the hours a buy order sits unattended,
defaulting to `23-07` in `config.json`. `best_window(bid_index, minimize=True)` is used
only by the `hours` display command, never by the craft economics.

That distinction is the difference between two questions. "When is this material
cheapest?" is interesting. "What will my order actually fill at while I am asleep?" is the
one the plan depends on, and the cheap hours are not necessarily the hours you are away.
Pricing against the cheapest window quietly assumes you are awake to place an order at the
best moment, which is the opposite of the strategy being modelled.

`meanOverHours` and `hourRange` were added to `profile.ts` to express it. `hourRange`
wraps midnight, because the default overnight window does. `meanOverHours` returns
`undefined` rather than 0 when no requested hour has data: the Python returns `0.0` and
relies on `or last_bid` at the call site, but 0 is a legitimate price for a dead item, so a
"no data" sentinel must not also be a possible answer.

**The tick moved inside `analyzeCraft`** in the same pass. The Python applies it at the
call site for the timed prices and inside `craft_economics` for the order prices; doing it
in one place means a caller cannot forget, and `orders` and `timed` are guaranteed to step
inside the book identically. `CraftInputs` therefore takes the raw window prices —
`timedBuyWindowBid`, `timedSellWindowAsk` — and applies the tick itself.

---

## ADR-015 — Throughput is not scaled by the player's waking hours

**Date:** 2026-08-24 · **Status:** accepted · **Reverses an invented behaviour**

An earlier version of `computeThroughput` multiplied crafts-per-day by the fraction of the
day the player was awake, on the reasoning that you cannot craft while asleep.

That was invented, not ported, and it contradicts the premise. `craft_economics` takes no
sleep parameter at all: throughput is `min(supply, demand)` and nothing else. The whole
point of the strategy is that the **buy order fills overnight while you sleep** — the
sleep window is an input to the buy _price_, not a penalty on volume. Crafting a day's
worth of material takes seconds once it has arrived.

The old behaviour understated profit-per-day by a third on a default 8-hour sleep window,
on the site's primary ranking key. `MarketConfig.sleepHours` is gone; the sleep window now
reaches the model as `timedBuyWindowBid` via `meanOverHours`, which is what it was always
for.

---

## ADR-016 — R2 archive: one object per tick, not one bundled object per day

**Date:** 2026-08-25 · **Status:** accepted · **Corrects CLAUDE.md section 3**

CLAUDE.md section 3 said to bundle each day's 288 ingest ticks into one R2 object, to
keep operation counts down. Implementing Phase 2's ingest against that plan surfaced two
platform limits that make it actually unsafe, not just suboptimal:

1. R2 multipart uploads require a 5MB minimum part size. One tick's raw payload is
   ~481KB gzipped — 10x too small to be its own part, so appending a part every 5
   minutes doesn't work without buffering several ticks first.
2. Workers isolates cap at 128MB memory, hard, non-negotiable. Holding a growing
   ~136MB/day blob in memory to decompress, append to, and re-upload every 5 minutes is
   unsafe well before the 14-day full-order-book window ends, even though the same
   design would be comfortable at the ~26MB/day steady state after.

The concern that motivated daily bundling — "operation counts matter as much as bytes" —
turns out not to bind at this volume. 288 writes/day is ~8,640/month against R2's
1,000,000/month free Class A operation allowance: 0.9% of it. So the fix is simpler than
working around the multipart floor: write one small object per tick to a dated prefix,
`archive/{YYYY-MM-DD}/{HHmm}.json.gz`. No step ever needs more than one tick (~481KB) in
memory, and per-tick objects are directly addressable by timestamp for a future consumer,
with no multi-gzip-member blob to parse apart.

The 14-day full-detail window is now enforced by a daily downgrade pass
(`pruneArchiveDetail` in `src/worker/archive.ts`) rather than a write-time decision: once
a day's ticks turn 15 days old, it rewrites them from full order books to `quick_status`
only. It processes exactly the one date that crosses the boundary on a given run, not a
backlog scan, and is idempotent by object size (an already-downgraded tick is small
enough to skip on a re-run) rather than needing separate bookkeeping.

**Cost:** more R2 objects to eventually consolidate. The literal "one object per day"
artifact CLAUDE.md originally wanted is deferred to Phase 8 (already gated behind 30
clean days) as an offline job folding a day's tick objects into one file — built against
real R2 data at that point, rather than guessed batching logic during Phase 2.

---

## ADR-017 — Phase 3 backfill is deferred until after production ingestion

**Date:** 2026-08-25 · **Status:** accepted

Phase 3 (Coflnet backfill into `hourly`) was skipped to get Phase 2's cron into
production first. Recording why, because the ordering looks like corner-cutting and
isn't.

The two data sources have opposite decay properties. Coflnet's history is *their*
archive: it is as available next month as it is today, so a month of delay costs
nothing. Our own five-minute history exists only for the wall-clock hours our cron was
actually running — a delayed deploy is history that no later work can recover
(CLAUDE.md section 3b). Backfill-before-deploy therefore trades an unrecoverable
resource for a recoverable one.

Backfill also does not unblock Phase 4. Its Done-when is a KV-read latency figure,
which is independent of how many rows `hourly` contains. And the throughput model —
crafts/day, hours-to-fill, the volume sanity checks — runs off `sellMovingWeek`, which
arrives complete in the very first snapshot.

What genuinely degrades without it is narrow: hour-of-day profiling, and the 7d/30d
windows in `/api/item/:tag`. Both degrade *honestly* rather than silently —
`computeHourProfile` reports per-hour `samples` (`packages/core/src/profile.ts`), so a
profile built from thin data reads as thin instead of being averaged into a confident
wrong answer. That is what makes the deferral safe rather than merely convenient.

**Cost:** the gap-detection half of Phase 3 — cross-referencing Coflnet's rows against
ours to find holes in our own collection — is also deferred, and that is the half worth
having regardless of whether profiling needs seeding. Until it exists, `runs` and
`hourly.samples` are the only gap detectors.

**Revisit:** before Phase 5 puts hour-of-day charts in front of users. Structurally free
to defer — `hourly.source` already exists with default `'hypixel'`
(`migrations/0001_initial.sql`), so coflnet rows drop in later with no migration and
stay distinguishable from our own.

---

## ADR-018 — Ingest stamps the tick boundary, not the wall clock

**Date:** 2026-08-25 · **Status:** accepted

Every row an ingest tick writes — `products.ts`, `snapshots.ts`, the `hourly` row's
`last_tick_ts`, and the R2 archive key — is now stamped `floor(now / 300) * 300` rather
than `now`. `runs.started_at` deliberately keeps the wall clock: when a tick actually
executed is exactly what an operator needs to see there. Only the data is quantized.

Forced by a real incident. From 2026-08-25 18:10 to roughly 21:40, Cloudflare delivered
every cron **twice**, about 55 seconds apart — confirmed in observability logs as two
distinct `requestId`s with two distinct `scheduledTime`s on one cron expression and one
script version. It stopped on its own, without a redeploy, and the mechanism was never
established.

ROADMAP Phase 2 already required "a retry at the same timestamp upserts, never
duplicates", and `buildHourlyIncrementalUpsert` already carried a `last_tick_ts <
excluded.last_tick_ts` guard for exactly this. Wall-clock stamps defeated both: the
second delivery arrived with a *later* timestamp, so it was never the "same timestamp"
the invariant was written about. `snapshots` took two rows per tag per tick and
`hourly.samples` reported 24 where the truth was 12 — the single number CLAUDE.md
section 3b relies on to expose thin data rather than average it away.

Quantizing repairs both paths at once with no schema change: a repeat delivery collides
on `(tag, ts)` and collapses via UPSERT, and the `last_tick_ts <` guard finally fires
because the repeat now carries the same value. It also makes the series evenly spaced,
which `stats.ts` and `profile.ts` both quietly assume.

**Cost:** a tick that fires *early* — before its boundary — would be attributed to the
previous window and overwrite it. Cloudflare's scheduler runs late, not early (observed
offsets were +4s to +12s), so this is theoretical, but it is the failure mode to look for
if a tick ever goes missing.

`tickBoundary` is exported purely so the regression test can assert the incident's real
timestamp pair (21:15:04 and 21:15:59) maps to one boundary. Inlining it back to
`Date.now()` is the mistake that test exists to catch.

---

## ADR-019 — Scan parameters are rejected, not clamped or defaulted

**Date:** 2026-08-25 · **Status:** accepted

`parseScanQueryParams` now returns a typed result and `/api/scan` and `/api/craft/:tag`
answer 400 with a message naming the parameter and its range. Previously any finite
number was accepted and anything unparseable fell back to the default.

The specific trap is `tax`, which is a **fraction**: `?tax=1.25` meaning "1.25%" asks for
a 125% sell tax. Unvalidated, that returns 200 with every craft showing a large,
confident, wrong loss — indistinguishable from a real market signal. A UI that sends
percents would poison every number on the page with nothing in the response indicating
anything went wrong. It was found by accident, by passing `tax=1.5` while testing the
live D1 path.

Three options were considered: clamp to range, fall back to the default, or reject.
Rejecting is the only one that cannot silently answer a question the user did not ask.
Falling back is the worst of the three — it returns numbers computed at 1.25% to someone
who asked for something else, with no signal. This is the same reasoning as CLAUDE.md
section 7.6: a scan figure is something a person may act on with real coins, so it never
ships without its caveats, and it certainly never ships computed from inputs quietly
swapped underneath it.

Ranges are wider than reality (`tax` allows up to 0.5 where the real ceiling is 0.0225
under Mayor Aura) — the job is to catch inputs wrong by a *factor*, not to second-guess
someone modelling an unusual scenario. `capital` is absent-vs-present rather than
range-checked: no `capital` means "unconstrained", which is a different scan from one
constrained to 0 coins.

---

## ADR-020 — Local dev does not bind the production KV namespace

**Date:** 2026-08-25 · **Status:** accepted

`"remote": true` is removed from the `CACHE` binding in `wrangler.jsonc`.

With it set, `wrangler dev` reads **and writes** the production KV namespace. On
2026-08-25 that is exactly what happened: a local dev session wrote `scan:default:v1` at
18:36, when `hourly` held barely any data, and production served that payload — 42
recipes all reporting `no-base-data` — for hours afterwards. Nothing in `runs` showed a
problem, because no cron had written it; the deployed `precompute` at the time was still
the stub. The API behaved correctly throughout, honestly labelling the payload stale
(CLAUDE.md section 5), which is the only reason it was noticeable at all.

CLAUDE.md section 3 already says KV holds precomputed payloads written by cron and never
per-request writes. A dev session is even further from "written by cron" than a request
handler is. Local dev now gets an empty namespace, and `/api/scan` takes its live-D1
fallback — the path worth exercising locally anyway, since it is what production serves
before the first successful precompute of any new deploy.

**Cost:** you can no longer inspect real precomputed payloads from `wrangler dev`. Read
them with `wrangler kv key get` instead, or re-add the flag deliberately for one session
and remove it again. The failure this prevents is silent and production-visible; the
inconvenience it creates is neither.

---

## ADR-021 — Nothing is retained longer than 30 days

**Date:** 2026-08-26 · **Status:** accepted

Every table and the R2 archive prune at 30 days. `hourly` and `daily` were previously
"keep indefinitely"; `snapshots` stays at 7 days, unchanged.

This is a **product** decision, not a storage workaround. The site's primary feature is a
*trailing* weekly high/low band used to place buy orders at the low and sell offers at the
high (CLAUDE.md section 8). A price from six weeks ago is not evidence about next week's
band, so the data was being kept for a use that does not exist. Storage was never the
binding constraint — `hourly` was only ~231 MB/year — which is precisely why an
indefinite-retention policy could have survived unexamined for years.

What it buys, beyond simplicity: the system reaches a steady state and stays there. D1
lands at ~538 MB flat (about 5% of the 10 GB cap) instead of climbing, and the R2 archive
stops at ~2.3 GB, which keeps it permanently inside the free tier rather than exhausting
it around day 75. Capacity planning stops being a recurring question.

**Costs, all real and all accepted:**

- **Phase 8 becomes a rolling window, not an archive.** We are no longer the place to get
  historical bazaar data, and the manifest has to say so. Weaker product, but also a
  weaker claim on Hypixel's API policy, which is not nothing.
- **Gaps hurt more, not less.** Against an unbounded archive a three-day outage is a
  rounding error; against a 30-day window it is 10% of everything the site knows, and 43%
  of the input to any given weekly band. Retention shrank; section 3b's monitoring
  requirement did not.
- **Backfill is capped at 30 days.** Fetching older data spends someone else's rate limit
  on rows the next prune deletes (ADR-017, ROADMAP Phase 3).
- **Reprocessing has a horizon.** There is no deep archive to rebuild a derived table from
  if a rollup bug is found late. Bugs older than a month are unrecoverable by definition.

The clause most likely to be attacked later is the R2 delete, on a "storage is cheap,
let's just keep it" instinct. Storage being cheap was never the argument.

---

## ADR-022 — Book level-endpoints are Tier A regardless of volume

**Date:** 2026-08-26 · **Status:** accepted

Tier A gains a third clause: the **lowest- and highest-level book of every enchant
family**, in addition to recipe tags and the top ~500 by `sellMovingWeek`. This adds ~283
tags, taking Tier A from 501 to ~784.

The existing volume rule put exactly **3** of 774 book tags into Tier A, which would have
made anvil merging (ADR-023) unbuildable — the strategy consumes level-1 books and
produces max-level books, and neither rung was being sampled at five-minute resolution.

Ranking books by unit volume is the trap, and it is not obvious. Measured against a live
hour:

| Level position | Tags | % unit volume | % coin turnover | Avg price |
|---|---|---|---|---|
| Lowest | 143 | 72.3% | 70.1% | 2.8M |
| Max | 143 | **4.6%** | **21.0%** | 20.0M |
| Intermediate | 476 | 22.9% | 7.9% | 2.0M |

Max-level books are 4.6% of units but **21% of coin turnover**, because they average 20M
coins each against 2.8M for level 1. Any volume-ranked rule drops exactly the rung the
strategy sells into. Level-1 + max together are 91% of book coin turnover in 286 of 774
tags, so the endpoints are also the efficient cut — the 476 intermediate tags carry 7.9%.

Intermediate levels stay Tier B unless they earn a slot on volume like anything else. They
are still priced for the cheapest-path solver, just from `hourly` rather than `snapshots`.

**Cost:** ~56% more five-minute rows written. At ~16.8M rows/month including deletes
against the 50M included, this stays inside the "keep roughly half the write budget free"
rule in CLAUDE.md section 2. It would not have, without ADR-021's retention cap.

---

## ADR-023 — One cheapest-path solver, not per-craft-type logic

**Date:** 2026-08-26 · **Status:** accepted

Anvil book merging and multi-step compaction are implemented as one generic
conversion-graph solver (`packages/core/src/convert.ts`), not as two code paths.

A recipe stops being "base × ratio → product" and becomes an edge; the question becomes
the cheapest path to one unit of output. Two apparently unrelated problems turn out to be
the same one:

- **Anvil chains.** Two books of level N make one of level N+1, so reaching level M from
  level L costs `2^(M-L)` books — Sharpness 1 → 7 is 64 books, not 6. Every intermediate
  rung is itself tradeable, so entering at level 3 is often cheaper than at level 1. The
  search over entry levels *is* the feature; a flat `ratio` column cannot express it.
- **Tier-2 compaction.** `SUGAR_CANE → ENCHANTED_SUGAR → ENCHANTED_SUGAR_CANE` is a
  two-step path priced identically. Seeded as a single 160:1 step, it reported a ~3,000%
  margin and ranked **first** in production at 1.77 billion profit/day. Implied price ratio
  across the other 41 recipes lands between 0.04 and 1.23; this one was 29.05.

Building anvil logic separately would mean discovering the same class of bug twice and
fixing it twice. The production SUGAR_CANE bug is the existence proof that the flat-ratio
model was already insufficient before books were considered.

Note what worked: the engine flagged that row `unverified-recipe` and `implausible-margin`
on its own. CLAUDE.md section 8's "a 200% margin means something is wrong" heuristic did
its job. What was missing was anything preventing a flagged row from ranking first — a
ranking concern, not a detection one.

**Cost:** more upfront design than a second `if` branch, and a graph solver is harder to
read than a multiplication. Accepted because `recipes` gains a `kind` discriminator either
way, and the alternative is two divergent implementations of the same arithmetic.

---

## ADR-024 — 0004/0005 are emptied so the migration chain can replay

**Date:** 2026-08-26 · **Status:** accepted

`0004_fix_remote_0001_drift.sql` and `0005_fix_remote_0001_drift_products_runs.sql` are
reduced to comment-only files (a bare `SELECT 1;` to keep wrangler happy). Their original
statements are preserved verbatim in those comments. This edits migrations that have
already been applied, which CLAUDE.md section 5 forbids.

**The problem.** Both files were one-time repairs for drift on the *remote* database,
caused by editing `0001` after it had been applied there. Their statements are
unconditional `ALTER TABLE ... ADD COLUMN`, and on any clean database `0002` has already
added every one of those columns. So a fresh chain died:

```
0001 ✅ → 0002 ✅ → 0003 ✅ → 0004 ✗ duplicate column name: ask_depth_1pct
```

Reproduced from scratch before deciding. That is not a dev-convenience bug: it means no
preview environment, no second dev machine, no disaster recovery, and ROADMAP Phase 6's
"CI runs migrations then deploys" could never have worked. The migration set had quietly
stopped being able to build the thing it describes.

**Why editing them is safe.** D1's bookkeeping is `d1_migrations (id, name UNIQUE,
applied_at)` — name-based, with no content hash. Remote recorded both filenames on
2026-08-25 and will never read them again. Verified before acting, not assumed.

**Why not a squash.** Squashing `0001`–`0005` into a baseline was the other candidate and
is the more conventional answer. It was rejected because it edits *more* applied
migrations (five instead of two) and additionally requires rewriting production's
`d1_migrations` rows by hand. Strictly more risk for the same end state. Emptying two
provably dead files is the smaller change.

**Verification.** A from-scratch replay now produces a database byte-identical to
production across all six application tables, with the same 43 recipes and — after
ADR-024's companion migration `0007` — the same five indexes.

**What this exposed on the way.** The index sets did *not* match. Production carried
`idx_daily_day_ts` and `idx_runs_kind_started`, which appear in no migration, and lacked
`idx_runs_started`, which `0001` creates. Someone had created indexes directly against
production. That is the same failure as editing a migration, pointed the other way, and it
is invisible until you try to build a second database. `0007` reconciles it by justifying
each index against a query that exists in the code, and drops `idx_runs_started`, which no
query needs.

**Cost.** The rule in CLAUDE.md section 5 now has a documented exception, and exceptions
erode rules. Mitigated by stating the bar explicitly — "provably dead *and* actively breaks
new databases" — and by adding the replay check to section 5, so the property this rule
exists to protect is something you can actually test instead of merely intend.

---

## ADR-025 — An implausibly high merge margin means the merge does not exist

**Date:** 2026-08-26 · **Status:** accepted

Anvil edges whose *implied merge ratio* — `price(N+1) / (2 × price(N))` — exceeds **3** are
withheld from the conversion graph (`detectMergeGates`). The family then targets the
highest rung a merge can actually reach, rather than the highest rung the bazaar lists.

**Why.** The first anvil scan ranked `ENCHANTMENT_LOOTING_4 → _5` first at **2.88 billion
profit/day**, a 1,509% margin. The data was correct: Looting IV asks 50,000 and Looting V
asks 172,816,195. The *model* was wrong. Looting V is not obtainable from an anvil at all —
it comes from a minigame — so the conversion the scan was pricing does not exist. Seeding
edges from adjacent bazaar levels assumes every rung is mergeable, and that assumption is
false for a whole class of high-tier books.

The generalisation, and the reason this is a rule rather than a special case: **an
enormous margin on a merge is evidence the merge is impossible, not evidence of a
bargain.** Nobody leaves a 1,500x conversion open.

**Why a price heuristic rather than a list.** A hardcoded set of un-mergeable enchants
would stale the moment Hypixel adds one, which is the same failure mode CLAUDE.md section 2
forbids for tier assignment and migration 0008 forbids for edge seeding. The price signal
is derived, self-updating, and needs no enchant knowledge.

**Why 3.** Measured, not guessed. Across the 320 edges with prices on both rungs the
implied ratio is sharply bimodal — 127 of the first 144 sampled sat under 1.5, and the tail
past 3 is dominated by top rungs (`TURBO_WARTS_4` at 1,334,189x, `FEATHER_FALLING_7` at
3,879x, several Ultimates). 3 is also exactly CLAUDE.md section 8's existing rule of thumb
— a 200% margin means the recipe is wrong, the item is dead, or someone is walling it — so
this applies an established heuristic to a chain rather than inventing a new one. 45 of 320
edges are currently gated. The threshold is a parameter, because the 3-10 band is genuinely
ambiguous.

**Unjudgeable edges stay usable.** If either rung is unpriced the edge is kept, not gated.
Absence of evidence is not evidence of a gate, and `cheapestPath` already refuses to route
through a rung it cannot price — gating on missing data would delete real chains every time
a thin rung skipped an hour.

**Cost.** A genuinely spectacular merge sitting above 3x would be suppressed, and we would
not know. Mitigated by returning the gated set with its ratios rather than discarding it,
so "why is this family capped at level 4" is answerable. Anvil rows fell from 101 to 46
when this shipped: 45 gated edges truncate many chains, and a family whose remaining chain
cannot beat simply buying the top rung is correctly no longer an opportunity.

**Bug found alongside.** The price feed keyed off one global `MAX(hour_ts)`, which is a
partial hour — a thin book that had not traded in it was simply unpriced. That covered 482
of 777 book tags, and the 295 it dropped were disproportionately the thin, high-value top
rungs this scan exists to evaluate (`ENCHANTMENT_LOOTING_5` among them, which is why the
first gate pass missed the very case that motivated it). Now a per-tag latest price over a
48h lookback, covering all 777.
