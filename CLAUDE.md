# CLAUDE.md — bazaar.liamthemo.com

Bazaar craft analytics for Hypixel SkyBlock. Tracks base→enchanted craft margins,
diurnal price patterns, and volume-adjusted profitability. Public read-only site.

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
- ask→bid ("instant both ways") is the *floor* scenario. bid→ask is the realistic case
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
   ONE request, ALL ~1500 products,                │                    │
   no API key required                             │                    ├─ :07  hourly rollup
   response is several MB — you cannot             │                    ├─ 04:23 daily + prune
   ask for a subset                                │                    └─ :07  precompute → KV
                                                   │                              │
                                                   └──▶ R2 raw archive            ▼
                                                        (see §3 sizing)   /api/* reads KV or D1

SkyCofl /api/bazaar/{tag}/history ── manual, once ──▶ hour-of-day seed only
   local script, NEVER from the Worker
```

### Tiered coverage — the decision that keeps this inside the limits

We do **not** store five-minute rows for all 1500 products. Coverage, not retention, is
the lever that controls growth.

| Tier | Which tags | Storage | Growth |
|---|---|---|---|
| **A** | recipe tags, **plus** any tag in the top ~500 by `sellMovingWeek` | 5-min `snapshots` pruned at 7d, `hourly` forever | ~350 MB/year |
| **B** | everything else | `hourly` only, no snapshots, pruned to 90d then `daily` | bounded |

Tier A membership is **recomputed each run**, not a static list. A tag that starts trading
gets promoted automatically; a dead one falls out. Promotion must never require a
migration.

On Workers Paid this is a choice, not a constraint — full 5-minute coverage of all 1500
products would be ~26M rows/month written against the 50M included, and ~2 GB/year in
`hourly` against a 10 GB cap. It fits. We tier anyway because five-minute resolution on an
item nobody trades has no analytical value and consumes the headroom we'd want for
backfills, reprocessing, and schema migrations. Keep roughly half the write budget free.

The reason we still fetch all 1500 products: Hypixel returns them in one response and
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

| Upstream | Allowed in | Forbidden in |
|---|---|---|
| `api.hypixel.net/v2/skyblock/bazaar` | `scheduled` handler only | `fetch` handler, client |
| `sky.coflnet.com/api/...` | `scripts/backfill.ts` (local Node) only | Worker, client |

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
- **D1 storage** — 10 GB max per database on paid, 500 MB on free; 1 TB per account.
  Retention policy is not optional. Figures below are measured from a live payload, not
  estimated (see the Phase 0.5 checkpoint in `docs/ROADMAP.md`):
  - The bazaar currently returns **2,136 products**, not ~1500 — the catalog has grown
    since that figure was written. Treat "~1500" elsewhere in this doc as stale by ~40%.
  - `snapshots` (5-min, Tier A, 150 recipe tags): prune to **7 days** ≈ **44 MB** steady
    state (measured ~154 bytes/row, 43.2k rows/day). The 80 MB estimate was ~1.8x high.
  - `hourly`: keep indefinitely. Tier A (150 recipe tags) ≈ **231 MB/year** measured
    (~184 bytes/row, 3.6k rows/day) — this is the table that grows forever, so it is the
    one to watch. The 350 MB/year estimate was ~1.5x high.
  - `daily`: keep indefinitely, serves anything older than 90 days
  - Untiered (all 2,136 products at 5-min) would be **32.2 GB/year** in `snapshots` and
    **3.2 GB/year** in `hourly` alone. That is the plan we rejected; do not drift back
    into it by "temporarily" widening coverage. (The old ~2 GB/year untiered-hourly
    estimate was low mainly because it assumed ~1500 products, not 2,136.)
- **Deletes count as rows written.** Pruning is not free — budget deletes alongside
  inserts when checking against the 50M/month included.
- **R2 raw archive sizing** — the full response including `buy_summary`/`sell_summary` is
  3.45 MB raw, **481 KB gzipped** (measured, 7.3x compression). Across a full day's 288
  cron ticks that's **~135 MB/day gzipped**, which exhausts R2's 10 GB free allowance in
  **~76 days (~11 weeks)**, not five — the original estimate was ~2.2x too pessimistic.
  Still keeps growing, so the mitigations stand:
  - **One small object per tick** (`archive/{YYYY-MM-DD}/{HHmm}.json.gz`), **not** one
    bundled object per day as this section previously said — see ADR-016. Bundling
    collides with two hard platform limits: R2 multipart uploads need a 5MB minimum part
    size (one tick's ~481KB gzipped payload is 10x too small to be its own part), and
    Workers isolates cap at 128MB memory, unsafe for holding a growing ~136MB/day blob to
    decompress/re-upload every 5 minutes. At 288 writes/day, per-tick objects cost ~0.9%
    of R2's 1,000,000/month free Class A operation allowance — the "operation counts
    matter" concern that originally motivated daily bundling isn't actually binding at
    this volume.
  - Keep full order books for **14 days**; a daily job downgrades one day's ticks to
    `quick_status`-only once they cross that age (`src/worker/archive.ts`,
    `pruneArchiveDetail`), rather than deciding full-vs-reduced at write time
  - Beyond 14 days, archive `quick_status` only — **measured at 19.3% of the full gzipped
    size** (~26 MB/day, ~9.3 GB/year), not the ~10% originally assumed, but still enough
    to recompute every derived table
  - The literal "one object per day" artifact, if wanted for public dataset dumps, is an
    offline consolidation step at Phase 8 time (already gated behind 30 clean days),
    built against real R2 data instead of guessed batching logic today
- **Order books are never stored raw in D1.** 1500 products × ~60 levels = 90k rows per
  snapshot; at 5-minute intervals that is 26M rows/day and D1 will not tolerate it.
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
  *precomputed* payloads written by cron, never per-request writes.
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

Corollary: **start ingesting as early as possible.** Every day of delay is a day of
history you cannot recover. Deploy the cron standalone the moment Phase 2 works — before
the API exists, before there is any frontend.

---

## 4. Repo layout

```
packages/core/          Pure TS domain logic. ZERO platform imports.
  src/sides.ts            ask/bid derivation, normalization
  src/stats.ts            price stats, volatility, spread
  src/profile.ts          hour-of-day profiling, best-window search
  src/economics.ts        craft profit model, throughput caps
  src/recipes.ts          recipe types + validation
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
- Migrations are forward-only and numbered. Never edit an applied migration.

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
     *our* computed results.
   - Any published dataset ships as aggregates, never a verbatim re-emission (see
     ROADMAP Phase 8).
   The penalty for getting this wrong is losing API access, which ends the project.
4. **No secrets in the client bundle.** Any Coflnet account token lives in `.dev.vars`
   locally and Worker secrets in prod. The client calls only `/api/*`.
5. **No user accounts in v1.** Watchlists go in `localStorage`. Adding auth means handling
   PII, and that is a different project with different obligations.
6. **The site gives estimates, not advice.** Every profit figure ships next to its
   fill-feasibility caveat. Do not build UI that shows a margin number alone.

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
  *below* 160× base. Real craft spreads are typically 1–5%, not 30%. **If the scan shows a
  200% margin, the recipe is wrong, the item is dead, or someone is walling it.** Rank by
  profit-per-day, never by margin.
- Collection-level gating means a profitable craft may be unavailable to a given player.
  Surface the requirement where known; do not pretend it doesn't exist.
