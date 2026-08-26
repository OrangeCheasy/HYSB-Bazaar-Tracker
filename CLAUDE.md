# CLAUDE.md — bazaar.liamthemo.com

Bazaar analytics for Hypixel SkyBlock. Three things: **trailing weekly high/low bands**
for placing buy orders at the low and sell offers at the high, **base→enchanted craft
margins**, and **anvil book merges**. All volume-adjusted, all with fill feasibility
attached. Public read-only site, rolling 30-day data window.

> Keep this file under ~400 lines. It loads into every session, so it holds **durable
> rules and invariants only**. Phase plans live in `docs/ROADMAP.md`. Anything that
> changes weekly belongs in a doc, not here.

---

## 1. The invariant that everything depends on

Hypixel's bazaar field names are inverted from intuition. `buyPrice` is what **you pay
to instant-buy** — it is the lowest sell offer, not what a seller receives. Nearly every
third-party tool gets this backwards at least once.

**We never trust the field names.** We derive sides structurally:

- `ask` = the **higher** of the two prices = lowest sell offer.
  You pay this to instant-buy. Your own **sell offer** competes here.
- `bid` = the **lower** of the two prices = highest buy order.
  You receive this when you instant-sell. Your own **buy order** competes here.

`ask > bid` always, because a crossed book would match immediately. This makes the
detection unfalsifiable and self-correcting if an upstream field is ever renamed.
Volume/moving-week fields pair to whichever side shares their prefix.

**Consequences for the product's core math:**

- A buy order fills near `bid`. A sell offer fills near `ask`.
- ask→bid ("instant both ways") is the _floor_ scenario. bid→ask is the realistic case
  **conditional on both orders filling**, which is why every profit figure must be shown
  alongside a fill-feasibility number.

There is a regression test (`packages/core/test/sides.test.ts`) that feeds deliberately
inverted input and asserts identical output. **Never delete or weaken it.** If it fails,
the site is printing backwards profit numbers and must not deploy.

---

## 2. Architecture

Single Worker, single deploy. Static SPA assets and API routes ship together.

```
orangecheasy.net
└── Worker  (src/worker)
    ├── assets   → dist/client   Vite SPA, not_found_handling: single-page-application
    ├── fetch    → /api/*        run_worker_first, everything else serves assets
    └── scheduled                ingestion + rollup + precompute
    bindings:
      DB     D1     time series, recipes, products
      CACHE  KV     precomputed scan payloads read by the homepage
```

### Data flow — read this before touching ingestion

```
Hypixel /v2/skyblock/bazaar  ── cron */5 ──▶ tier split ──▶ snapshots (D1, Tier A only)
   ONE request, ALL 2,136 products,                │                    │
   no API key required                             │                    ├─ :07  hourly rollup
   response is several MB — you cannot             │                    ├─ 04:23 daily + prune
   ask for a subset                                │                    └─ :07  precompute → KV
                                                   │                              │
                                                   └──▶ R2 raw archive            ▼
                                                        (30d, see §3)     /api/* reads KV or D1

SkyCofl /api/bazaar/{tag}/history ── manual, once ──▶ hour-of-day seed only
   local script, NEVER from the Worker           (≤30d — anything older is pruned anyway)
```

Everything above prunes at 30 days (§3). The 04:23 job is the only thing standing between
this design and unbounded growth; if it silently stops, nothing else notices.

### Tiered coverage — the decision that keeps this inside the limits

We do **not** store five-minute rows for all 2,136 products. Coverage is the lever that
controls write volume; **retention is capped at 30 days everywhere** (§3), so nothing in
this system grows without bound.

| Tier  | Which tags                                                                                                                             | Storage                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **A** | recipe tags, **plus** any tag in the top ~500 by `sellMovingWeek`, **plus** the lowest- and highest-level book of every enchant family | 5-min `snapshots` pruned at 7d, `hourly` at 30d |
| **B** | everything else                                                                                                                        | `hourly` only, no snapshots, 30d                |

Tier A membership is **recomputed each run**, not a static list. A tag that starts trading
gets promoted automatically; a dead one falls out. Promotion must never require a
migration. **Measured 2026-08-26 after the book clause shipped: 793 Tier A tags, of which
295 are book level-endpoints** — 620 anvil edges derived from 155 families.

**Why book level-endpoints get in regardless of volume.** Anvil merging (§8) consumes
level-1 books and produces max-level books; those two rungs are the only ones a merge
strategy actually trades. Measured against a live hour, of 774 book tags:

| Level position | Tags | % unit volume | % coin turnover | Avg price |
| -------------- | ---- | ------------- | --------------- | --------- |
| Lowest         | 143  | 72.3%         | 70.1%           | 2.8M      |
| **Max**        | 143  | 4.6%          | **21.0%**       | 20.0M     |
| Intermediate   | 476  | 22.9%         | 7.9%            | 2.0M      |

Level-1 + max is **91% of book coin turnover in 286 of 774 tags**. Rank books by unit
volume and you will wrongly drop the max-level rung — it is 4.6% of units but 21% of
coins, because those books average 20M each. The plain top-500-by-volume rule put only
**3** books in Tier A, which is why the level-endpoint rule exists as a separate clause.
Intermediate levels stay Tier B unless they earn a slot on volume like anything else.

On Workers Paid this is a choice, not a constraint — full 5-minute coverage of all 2,136
products is ~18.5M rows/month written against the 50M included, and with a 30-day cap it
now fits on storage too. We tier anyway because five-minute resolution on an item nobody
trades has no analytical value, and 43% of book tags have _zero_ weekly volume. Keep
roughly half the write budget free for backfills, reprocessing, and schema migrations.

The reason we still fetch all 2,136 products: Hypixel returns them in one response and
offers no way to request a subset. Tiering happens after parsing, on our side.

**Rule: user requests never touch an upstream API.** Not once, not "just for the detail
page." Reasons, in order of severity:

1. Worker subrequests originate from Cloudflare's shared IP pool. SkyCofl rate-limits by
   IP (30 req/10s and 100 req/60s, enforced in parallel). Proxying user traffic gets the
   shared pool blacklisted, which harms other people's projects, not just ours.
2. Latency: a KV read is ~5ms, an upstream fetch is 200–800ms.
3. Cost and reliability: our uptime becomes their uptime.

The single Hypixel call returning every product at once is what makes this cheap. We
build our own history database from it and stop depending on anyone else's.

### Where each upstream is allowed to appear

| Upstream                             | Allowed in                              | Forbidden in            |
| ------------------------------------ | --------------------------------------- | ----------------------- |
| `api.hypixel.net/v2/skyblock/bazaar` | `scheduled` handler only                | `fetch` handler, client |
| `sky.coflnet.com/api/...`            | `scripts/backfill.ts` (local Node) only | Worker, client          |

---

## 3. Platform constraints that will bite

Verified against Cloudflare docs; re-check before assuming.

- **Workers Paid is active.** 30s CPU per invocation, 1000 D1 queries per invocation, 50M
  D1 rows written/month, 10 GB per database. Queues and Durable Objects are available.
  The remaining limits are real but generous — design for headroom, not survival.
  **Measured, not assumed:** `JSON.parse` on the live payload has a median wall time of
  **33.5ms** over 10 runs (min 21ms, max 51ms) — over 3x the free plan's 10ms CPU cap on
  parsing alone, before a single row is built or written. Workers Paid was never optional.
- **D1 query count per invocation** — 1000. Still never loop `INSERT` per product: bound
  parameters cap at **100 per query** regardless of plan, so chunk by parameter count,
  not row count, and use `db.batch()`.
- **Nothing is kept longer than 30 days.** This is a product decision, not a storage
  workaround: the site exists to compute a _trailing_ weekly high/low band (§8), and a
  price from six weeks ago is not evidence about next week's band. Every table and the R2
  archive prune to 30 days, so the whole system reaches a steady state and stays there.
  The direct consequences, which you must not quietly undo:
  - **A gap older than 30 days is gone forever**, ours and anyone's. §3b's monitoring is
    what protects the window; there is no longer a deep archive to reprocess from.
  - **Phase 8 publishes a rolling 30-day window**, not an accumulating dataset.
  - **Backfill beyond 30 days is pointless** — the next prune deletes it (ROADMAP Phase 3).
- **D1 storage** — 10 GB max per database on paid, 500 MB on free; 1 TB per account.
  Figures are measured from a live payload, not estimated (see the Phase 0.5 checkpoint in
  `docs/ROADMAP.md`), and are **steady state, not annual growth**:
  - `snapshots` (5-min, Tier A, 793 tags measured): prune to **7 days** ≈ **246 MB** steady state
    (measured ~154 bytes/row, 228k rows/day). Larger than the old 44 MB figure because
    Tier A grew from 150 recipe tags to 793 once book level-endpoints were included.
  - `hourly` (all 2,136 products): prune to **30 days** ≈ **283 MB** steady state
    (measured ~184 bytes/row, 51.3k rows/day). Previously "keep indefinitely" at
    231 MB/year — the cap converts an unbounded liability into a fixed cost.
  - `daily` (all products): prune to **30 days** ≈ **12 MB**. Its old job — serving
    anything older than 90 days — no longer exists. It survives because it is the cheap
    table to compute multi-week band hit-rates from (§8).
  - **Total ≈ 538 MB and flat**, about 5% of the 10 GB cap, with ~16.8M rows/month written
    including deletes against the 50M included (~34%).
  - Untiered 5-min coverage of all 2,136 products would be 617 MB at 7-day retention —
    which now _fits_. The storage argument for tiering has evaporated; the write-budget
    and signal-quality arguments in §2 are what remain.
- **Deletes count as rows written.** Pruning is not free — budget deletes alongside
  inserts when checking against the 50M/month included.
- **R2 raw archive sizing** — the full response including `buy_summary`/`sell_summary` is
  3.45 MB raw, **481 KB gzipped** (measured, 7.3x compression; re-verified 2026-08-25
  against a live object at 3.44 MB / 485 KB / 7.3x). Across a full day's 288 cron ticks
  that's **~136 MB/day gzipped**. Unbounded, that exhausted R2's 10 GB free allowance in
  ~75 days. **With the 30-day cap it reaches ~2.3 GB and stops** — 14 days of full order
  books (1.9 GB) plus 16 days of `quick_status`-only (0.4 GB) — so the archive now lives
  permanently inside the free tier. The mitigations below are what keep it there:
  - **One small object per tick** (`archive/{YYYY-MM-DD}/{HHmm}.json.gz`), never a bundled
    daily object — bundling collides with R2's 5MB minimum multipart part size and the
    128MB isolate memory cap. See ADR-016 for the full reasoning.
  - Keep full order books for **14 days**; a daily job downgrades one day's ticks to
    `quick_status`-only once they cross that age (`src/worker/archive.ts`,
    `pruneArchiveDetail`), rather than deciding full-vs-reduced at write time
  - Between 14 and 30 days, `quick_status` only — **measured at 19.3% of full gzipped
    size** (~26 MB/day), still enough to recompute every derived table
  - **Beyond 30 days, delete.** The same daily job that downgrades day 15 deletes day 31.
    This is what makes the archive flat rather than merely slow-growing, and it is the
    clause a future "let's just keep it, storage is cheap" instinct will attack first
- **Order books are never stored raw in D1.** 2,136 products × ~60 levels = 128k rows per
  snapshot; at 5-minute intervals that is 37M rows/day and D1 will not tolerate it.
  Compute depth metrics at ingest — depth within 1% and 5% of top of book, largest single
  wall, order count — store those few numbers, send the raw summaries to R2.
- **D1 primary location is effectively permanent.** Set it deliberately at creation with
  `--location` (`weur|eeur|apac|oc|wnam|enam`). Omitting it places the primary wherever the
  person running the command happens to be. Changing it later means export, recreate,
  reimport. Writes always route to the primary; read replication is free and automatic.
- **`--local` and `--remote` D1 are entirely separate databases.** Local dev writes a real
  SQLite file under `.wrangler/state/`. Migrations must be applied to both. Applying only
  locally and wondering why production has no tables is the single most common mistake here.
- **KV writes** are limited and eventually consistent (~60s global propagation). KV holds
  _precomputed_ payloads written by cron, never per-request writes.
- **Cron triggers** have no wall-duration limit on paid, but do not assume unlimited CPU.
  Split the work across separate cron expressions and branch on `event.cron`.

---

## 3b. Gaps are the real risk, not storage

Storage has years of headroom. What actually destroys the value of self-collected history
is discontinuity, and it fails silently: a cron errors for three days, Hypixel has an
outage, a deploy breaks the `scheduled` handler and nobody notices for a week because the
site keeps serving stale KV perfectly happily.

**You cannot backfill your own gaps.** Coflnet only helps for the window before you
started collecting, and only at their resolution.

Three mechanisms, all built in Phase 2 rather than bolted on later:

1. Every cron run writes to `runs` — success or failure, with duration and row counts.
2. Alert on **consecutive** failures, not single ones. A single failed run is noise; three
   in a row is an outage.
3. `hourly.samples` records how many snapshots built each row. An hour assembled from 2
   samples instead of 12 is visibly less trustworthy, and the API must surface that rather
   than averaging it away silently.

**The 30-day cap makes gaps worse, not better.** It is tempting to read "we only keep a
month" as "gaps matter less." The opposite is true: against an unbounded archive a
three-day outage is a rounding error, but against a 30-day window it is **10% of
everything the site knows**, and the weekly band (§8) is computed from a 7-day slice where
three missing days is 43% of the input. Retention shrank; the monitoring requirement did
not. Alert thresholds stay where they are.

Corollary: **start ingesting as early as possible.** Deploy the cron standalone the moment
Phase 2 works — before the API exists, before there is any frontend. The 30-day cap means
this is now a one-month runway to full fidelity rather than a permanent loss, but a site
whose bands are computed from four days of data is still a site that should not be
publishing bands.

---

## 4. Repo layout

```
packages/core/          Pure TS domain logic. ZERO platform imports.
  src/sides.ts            ask/bid derivation, normalization
  src/stats.ts            price stats, volatility, spread
  src/profile.ts          hour-of-day profiling, best-window search
  src/economics.ts        craft profit model, throughput caps
  src/recipes.ts          recipe types + validation
  src/convert.ts          conversion graph: cheapest path through multi-step recipes
  src/anvil.ts            enchant families, level chains, 2^k merge ratios
  src/bands.ts            trailing weekly high/low bands + hit-rate
  test/                   vitest, this is where coverage actually matters
src/worker/
  index.ts                fetch + scheduled entry, routes by event.cron
  ingest.ts               Hypixel pull → snapshots
  rollup.ts               snapshots → hourly → daily, pruning
  precompute.ts           scan results → KV
  api/                    route handlers, thin, no business logic
  db/                     query builders, migrations
web/                    Vite + React + TS SPA
scripts/                Local-only Node scripts (backfill, migrations, seeding)
migrations/             D1 SQL migrations, numbered, forward-only
docs/ROADMAP.md         Phase plan and definition of done
docs/DECISIONS.md       ADRs — one short entry per non-obvious choice
```

**`packages/core` must not import from `cloudflare:*`, `node:*`, or any fetch client.**
It takes plain objects in and returns plain objects out. This is the whole reason it can
be reused later by a Discord bot, a CLI, or a second site without a rewrite. If a
function needs data, it takes it as an argument.

---

## 5. Conventions

- TypeScript strict mode, `noUncheckedIndexedAccess` on. No `any` in `packages/core`.
- Money is `number` (float) — bazaar prices are genuinely fractional. Do **not** switch to
  integer cents; the upstream is float and rounding introduces drift at 160× multipliers.
  Round only at the display layer.
- All timestamps stored as **UTC epoch seconds** (integer). Timezone conversion happens in
  the browser using the user's `Intl.DateTimeFormat().resolvedOptions().timeZone`.
  Never store local times.
- API responses: `{ data, meta: { generatedAt, staleAfter, source } }`. Every payload
  states how old it is. Users making trades on 40-minute-old data need to know that.
- Errors: return typed results (`{ ok: true, value } | { ok: false, error }`) in core;
  throw only at boundaries.
- SQL lives in `src/worker/db/`, never inline in route handlers.
- Migrations are forward-only and numbered. **Never edit an applied migration** — doing so
  to `0001` is what caused the drift that `0004`/`0005` had to repair, and then made the
  whole chain unreplayable. Fix mistakes with a new numbered file.
  - **A fresh database must be able to replay the entire chain.** This is the property the
    rule protects and the one worth testing, because nothing else notices when it breaks:
    `wrangler d1 migrations apply bazaar --local --persist-to <tmpdir>` builds one from
    scratch. Do this after adding a migration.
  - **Never create an index or column directly against production.** Production carried two
    indexes that appeared in no migration until `0007` reconciled them; untracked drift in
    that direction is the same failure as editing a migration, just harder to see.
  - One deliberate exception exists (ADR-024: `0004`/`0005` emptied). Not a precedent — the
    bar was "provably dead _and_ breaks every new database", not "inconvenient".

## 6. Commands

```bash
npm run dev              # wrangler dev, local D1 + KV
npm run build            # vite build → dist/client
npm test                 # vitest, packages/core
npm run typecheck
npm run deploy           # wrangler deploy (CI does this; avoid running locally)
npm run db:migrate       # wrangler d1 migrations apply bazaar --remote
npm run db:migrate:local
npm run backfill -- --tag COAL --days 30
npx wrangler d1 info bazaar          # current database size — check monthly
```

Bindings: `DB` (D1), `CACHE` (KV), `ARCHIVE` (R2). The nightly cron records database size
into `runs` so growth is measured rather than estimated — a month of real numbers beats
any projection in this file.

## 7. Non-negotiables

1. **Attribution.** SkyCofl requires a visible link back to `sky.coflnet.com` on any page
   using their data. If the site ever becomes commercial (ads, donations for features),
   their terms require a Premium+ subscription. This is a real obligation, not a footnote.
2. **Disclaimer.** Footer must state the site is not affiliated with or endorsed by
   Hypixel or Mojang.
3. **Upstream policy compliance.** Hypixel's API policy prohibits commercial use,
   collection at scale, and proxying the Public API to third-party developers. Being free
   and open source clears the first only. Practical consequences that bind today:
   - Poll no faster than the bazaar actually refreshes (~60s). Five minutes is our choice.
   - Never expose an endpoint that mirrors an upstream response shape. Our API serves
     _our_ computed results.
   - Any published dataset ships as aggregates, never a verbatim re-emission (see
     ROADMAP Phase 8).
     The penalty for getting this wrong is losing API access, which ends the project.
4. **No secrets in the client bundle.** Any Coflnet account token lives in `.dev.vars`
   locally and Worker secrets in prod. The client calls only `/api/*`.
5. **No user accounts in v1.** Watchlists go in `localStorage`. Adding auth means handling
   PII, and that is a different project with different obligations.
6. **The site gives estimates, not advice.** Every profit figure ships next to its
   fill-feasibility caveat. Do not build UI that shows a margin number alone. For the
   weekly band (§8) the required companion number is the **hit-rate** — how often price
   actually reached that band — because a band nobody's order ever touches is not a
   trade, it is a chart annotation.

## 8. Domain gotchas worth remembering

- Recipe ratios are usually 160:1 but there are real exceptions (ender pearls 20, eggs
  144, hard stone 576). Tag existence can be validated automatically; **ratios cannot** —
  name matching cannot see a crafting grid. Every recipe carries a `verified` flag and
  unverified ones are visually marked in the UI.
- Bazaar sell tax is 1.25% base, 1% with Bazaar Flipper II, ~2.25% under Mayor Aura.
  It applies to sell offers only, never to buying. Make it a user-adjustable input, not a
  constant.
- Super Compactor 3000 in minions auto-crafts enchanted forms and dumps them in
  continuously. That supply is price-insensitive, so popular materials frequently trade
  _below_ 160× base. Real craft spreads are typically 1–5%, not 30%. **If the scan shows a
  200% margin, the recipe is wrong, the item is dead, or someone is walling it.** Rank by
  profit-per-day, never by margin.
- Collection-level gating means a profitable craft may be unavailable to a given player.
  Surface the requirement where known; do not pretend it doesn't exist.

### Anvil book merging — the second craft type

Two enchanted books of the **same enchant at the same level** combine in an anvil into one
book of the next level up. Reaching level `M` from level `L` therefore takes `2^(M-L)`
books — Sharpness 1 → 7 is 2⁶ = **64** level-1 books, not 6. Tags are
`ENCHANTMENT_{ENCHANT}_{LEVEL}` (`ENCHANTMENT_SHARPNESS_1`, `ENCHANTMENT_ULTIMATE_WISE_5`).

What makes this genuinely different from 160:1 compaction, and why it is not just another
`recipes` row:

- **The ratio is a power of two, not a constant**, and every rung in between is itself a
  tradeable bazaar item. You may enter the chain at _any_ level, so the model must pick
  the cheapest entry: `min over L < M of (2^(M-L) × price(L))`. Buying 16 level-3 books is
  frequently cheaper than 64 level-1 books. A single flat `ratio` column cannot express
  this — the search over entry levels is the feature.
- **This is the same machinery tier-2 compaction needs.** `SUGAR_CANE → ENCHANTED_SUGAR →
ENCHANTED_SUGAR_CANE` is a two-step path priced exactly the same way. Build one
  cheapest-path solver in `convert.ts` and both craft types use it; building anvil logic
  separately means fixing the same bug twice.
- **Fill feasibility dominates here.** Max-level books are 21% of book coin turnover but
  only 4.6% of unit volume — you are selling few, expensive items. `hoursToFillOneCraft`
  is the headline constraint, not a footnote, and capital-per-craft runs to tens of
  millions against a few thousand for enchanted materials.
- **Not every level is reachable by merging, and the price says which.** Many top rungs are
  obtainable only from elsewhere in the game — a minigame reward, a specific drop —
  _not_ from an anvil. `ENCHANTMENT_LOOTING_5` is the reference case: Looting IV asks
  50,000 and Looting V asks 172,816,195. Two Looting IV books do not make a Looting V, so
  the "1,509% margin" that produced is a trade nobody can execute.

  **An insanely high margin on a merge is evidence the merge does not exist**, not evidence
  of a bargain. The detector is the _implied merge ratio_,
  `price(N+1) / (2 × price(N))`: sharply bimodal across the 320 priced edges, with real
  merges under 1.5 and gated rungs in the tail past 3. `detectMergeGates` withholds edges
  above 3 — the same 200%-margin suspicion line, applied to a chain — so the family
  re-targets the highest rung a merge can reach. 45 of 320 are gated. An edge whose ratio
  cannot be computed stays usable: absence of evidence is not evidence of a gate. ADR-025.

- Ratios still cannot be validated automatically (the rule at the top of this section
  applies with more force, not less) — every anvil recipe carries `verified` and starts at
  `false`. The gate heuristic narrows the damage; it does not replace verification.
- Anvil coin/XP cost is **unverified**; treat it as an input to confirm, not a constant to
  hardcode. If it turns out non-zero it enters the cost side per merge, meaning `2^(M-L)-1`
  merges, not one.

### The weekly band — what the site is actually for

Place a **buy order** at the trailing weekly low, a **sell offer** at the trailing weekly
high, and collect the difference. Per §1 this is a bid→ask strategy, so it inherits that
section's caveat in full: it is the realistic case **conditional on both orders filling**.

- Sides follow §1 with no exceptions. A buy order competes at **`bid`**, so the low band
  is computed from the bid side; a sell offer competes at **`ask`**, so the high band comes
  from the ask side. Building the band from `ask_min`/`bid_max` inverts the strategy and
  produces orders that never fill.
- **Use percentiles, not `MIN`/`MAX`.** A single five-minute wick is not a price you can
  actually transact at. Default to p10 of hourly `bid_avg` for the buy band and p90 of
  hourly `ask_avg` for the sell band, computed over the trailing 7 days (168 hourly rows —
  a healthy sample). Make the percentile a user input, not a constant.
- **Always ship the hit-rate.** By construction a p10 buy order sits unfilled ~90% of the
  time. The band is only a trade if price actually visits it, so report how many hours in
  the window touched each band, and how often _both_ were touched in the same week.
  Non-negotiable #6 covers this.
- **Beware small n on the weekly view.** The band itself rests on 168 hourly rows, but
  "how many weeks did this hold" rests on **4** — the 30-day cap allows no more. Report the
  week count next to any multi-week claim rather than implying a long track record.
- This works on plain materials with no crafting at all, which is often the better trade:
  no collection gating, no recipe-ratio risk, and `verified` never enters the picture.
