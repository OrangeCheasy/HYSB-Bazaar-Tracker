# CLAUDE.md — orangecheasy.net

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
Hypixel /v2/skyblock/bazaar   ── cron */5 ──▶  snapshots (D1)
   ONE request, ALL ~1500 products,                │
   no API key required                             ├── cron :07 ──▶ hourly rollup
                                                   ├── cron 04:23 ─▶ daily rollup + prune
                                                   └── cron :07 ──▶ precompute → KV
                                                                        │
SkyCofl /api/bazaar/{tag}/history  ── manual ──▶ backfill seed          ▼
   local script only, NEVER from the Worker                    /api/* reads KV or D1
```

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

- **Workers Paid ($5/mo) is required.** Free plan caps CPU at 10ms per invocation. The
  ingest cron parses a multi-megabyte JSON payload and writes ~1500 rows; it will not
  fit. Free also caps D1 at 50 queries per invocation and 500MB per database.
- **D1 query count per invocation** — 1000 on paid, 50 on free. Never loop
  `INSERT` per product. Build one multi-row `INSERT ... VALUES (...),(...)` or use
  `db.batch()`, chunked to stay well under the cap. Bound parameters cap at 100 per
  query, so chunk by parameter count, not row count.
- **D1 storage** — 10GB max per database on paid. 1500 products × 288 snapshots/day is
  ~430k rows/day. Retention policy is not optional:
  - `snapshots` (5-min): prune to **7 days**
  - `hourly`: keep indefinitely (~36k rows/day, manageable)
  - `daily`: keep indefinitely, used for anything older than 90 days
- **KV writes** are limited and eventually consistent (~60s global propagation). KV holds
  *precomputed* payloads written by cron, never per-request writes.
- **Cron triggers** have no wall-duration limit on paid, but do not assume unlimited CPU.
  Split the work across separate cron expressions and branch on `event.cron`.

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
```

## 7. Non-negotiables

1. **Attribution.** SkyCofl requires a visible link back to `sky.coflnet.com` on any page
   using their data. If the site ever becomes commercial (ads, donations for features),
   their terms require a Premium+ subscription. This is a real obligation, not a footnote.
2. **Disclaimer.** Footer must state the site is not affiliated with or endorsed by
   Hypixel or Mojang.
3. **No secrets in the client bundle.** Any Coflnet account token lives in `.dev.vars`
   locally and Worker secrets in prod. The client calls only `/api/*`.
4. **No user accounts in v1.** Watchlists go in `localStorage`. Adding auth means handling
   PII, and that is a different project with different obligations.
5. **The site gives estimates, not advice.** Every profit figure ships next to its
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