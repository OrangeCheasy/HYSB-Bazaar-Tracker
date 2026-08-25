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
**Goal:** the cron fills D1 with real bazaar history, forever, without falling over.
**Effort:** 2–3 evenings

**Deploy this standalone the moment it works** — before the API, before any frontend.
History you did not collect is unrecoverable, and by the time Phase 5 is done you will
have three or four weeks of your own five-minute data. That is better than anything
Coflnet would give you for the same window.

Deliverables:
- Migrations for `products`, `recipes`, `snapshots`, `hourly`, `daily`, `runs`
- Tier assignment: a tag is Tier A if referenced by a recipe, else Tier B (CLAUDE.md §2).
  Config-driven, re-evaluated each run, never a migration
- `ingest.ts`: one fetch, normalize via `packages/core`, tier split, chunked multi-row
  insert. Tier A → `snapshots`; Tier B → `hourly` directly
- Order book depth metrics computed at ingest (depth within 1% and 5% of top of book,
  largest wall, order count). Raw summaries go to R2, never to D1
- R2 archive: one object per day, full order books 14 days, `quick_status` only beyond
- `rollup.ts`: hourly, daily, retention pruning per tier
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
**Goal:** seed enough history for hour-of-day profiling. That is all it is for now.
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

**Done when:** every tag referenced by a recipe has ≥30 days of `hourly` rows, and
re-running the script is a no-op rather than a duplicate.

---

## Phase 4 — API and precompute
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

**Done when:** the default scan responds in <50ms warm, and every endpoint returns a
correct `meta` block including during a stale-data window.

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
1. **Scan table** — sortable, ranked by profit/day. Columns: craft, profit/craft, margin,
   crafts/day, capital, flags. Filter by capital available.
2. **Craft detail** — three scenarios side by side, price chart with buy/sell windows
   shaded, hour-of-day bar chart, flag explanations in plain language.
3. **Item page** — ask/bid history, depth, volume, volatility.
4. **Settings drawer** — tax rate, capture fraction, sleep window, timezone. Persist to
   `localStorage`. These change results a lot, so they must be visible, not buried.

Non-negotiable UI rules:
- A margin number never appears without its fill-feasibility number adjacent
- Unverified recipes are visually marked
- Data age is always visible, not in a tooltip
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
- **Base-only diurnal view** — buy a material at 03:00, sell the same material at 19:00,
  no crafting. Often beats crafting outright, and no competitor front-pages it.
- **Backtest** — "if you had run this strategy for 30 days, here is what happened."
  Expensive to build, but it is the one thing that turns a calculator into a tool people
  trust.

Deliberately **not** doing: user accounts, a mod, a mobile app, real-money anything.

---

## Phase 8 — Publish the open dataset
**Goal:** the aggregated bazaar history, free and open, as bulk dumps.
**Effort:** 2 evenings, but gated behind a month of proven collection

**Hard gate: do not ship this until Phase 2 has run clean for 30 days.** A dataset with
unmarked gaps is worse than no dataset, because people build on it and your silent cron
failure becomes their corrupted analysis.

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
- One **Parquet** file per day. DuckDB and pandas load it directly, so a year of history
  is queryable on someone's laptop without touching our infrastructure at all.
- `manifest.json` — available dumps, schema version, date coverage
- **Coverage report shipped alongside every dump**: per-tag hour counts, `samples`
  distribution, and an explicit list of known gaps. Non-negotiable; see §3b.
- `Cache-Control: immutable` on dated files; short TTL on the manifest only
- Schema versioning. Once published, a column's meaning is frozen. Add columns, never
  repurpose them.
- LICENSE for the compilation (CC-BY-4.0 is the low-friction choice), plus a clear notice
  that the underlying data originates from Hypixel and that this project is not affiliated
  with or endorsed by Hypixel or Mojang.

**Done when:** someone who has never spoken to you can find the manifest, download a
month, load it in DuckDB, and correctly identify which hours are low-confidence — without
asking you anything.

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
