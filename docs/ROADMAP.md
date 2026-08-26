# ROADMAP

Eight phases. Each is independently shippable and independently _reversible_. Do not
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

**Status: BUILT 2026-08-26, not yet run against production.** `scripts/backfill.ts` is a
real script; typecheck and lint are clean. Verified against the **local** D1 rather than
asserted:

- `--days 45` is rejected with the retention reason. `--dry-run` against production reads
  **793 Tier A tags → 3,965 requests → ~1h 9m**, matching CLAUDE.md §2's measured count.
- A `COAL` run offered 158 rows and inserted **2** — the other 156 bounced off rows we
  already held, so a re-run is a no-op by construction and our own 12-sample rows are
  never displaced by a coarser Coflnet bar (ADR-031). A second full run changed the row
  count by zero.
- Resume verified by **SIGKILL**, not by a signal handler that might not fire: killed at
  36s, 25 of 30 tags were durably recorded, and the next run picked up exactly the
  remaining 5.
- The audit found real gaps on its first run — the two hours between the local fixture's
  last row and Coflnet's newest bucket — so the second job works, not just the first.

Three things came out of building it that the plan below did not anticipate. Coflnet's
resolution follows the **requested span**, not the age of the data, which is why the job
is 3,965 requests and not 793 (ADR-030). Coflnet's timestamps carry **no UTC offset**, so
`normalizeCoflnetPoint` was silently shifting every bar by the runner's local offset —
fixed in `packages/core` with three tests, and it would have been invisible to every
existing check (ADR-032). And the ESLint boundary this phase asks for had to be scoped to
`src/**` alone: flat config replaces rather than merges a repeated rule, so a block naming
core and web too would have quietly deleted their platform-free boundaries.

**Remaining:** run it against production (`npm run backfill -- --remote`, ~69 minutes) and
spot-check a few tags. Until that happens the Definition of Done below is unmet.

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
detect gaps in your collection. ~~At ~150 tags and one request per tag, it is a 95-second
job.~~ **Wrong by a factor of 43, measured 2026-08-26:** Tier A is 793 tags since the book
clause (CLAUDE.md §2), and Coflnet's resolution follows the requested span, so 30 days
needs five 7-day requests per tag rather than one — 3,965 requests and **~69 minutes**
(ADR-030). Still a one-time cost, but a run you start deliberately rather than
absent-mindedly, which is why it prints its ETA first and is resumable.

Deliverables:

- `scripts/backfill.ts` — local Node, hits SkyCofl, writes to D1 via the D1 HTTP API or
  `wrangler d1 execute --file`
- Rate limiter: min 1.05s between requests, honors `Retry-After` on 429
- Resumable: records progress so an interrupted run continues instead of restarting
- Writes into `hourly` directly, tagged `source='coflnet'` so it is distinguishable from
  your own data

Watch for:

- ~~SkyCofl coarsens resolution the further back you go~~ — **it coarsens by the span you
  request, not by age.** A 1-day window 29 days back still returns 2h buckets; an 8-day
  window returns daily ones. Ask for 30 days in one call and you get 30 points and no
  hour-of-day profile at all (ADR-030). Spacing is still uneven — Coflnet drops buckets
  where it has no data — so do not assume it.
- Coflnet's timestamps have **no UTC offset**, and `Date.parse` reads that as local time
  (ADR-032). Handled in `packages/core` now; do not re-introduce it in a new caller.
- This script must never end up imported by the Worker. ~~Enforce with an ESLint boundary
  rule if you can be bothered~~ — done: `NO_SCRIPTS_IMPORT` in `eslint.config.mjs`. Note
  it is applied to `src/**` in its own block and appended by hand inside the existing
  `packages/core` and `web/src` blocks, because flat config **replaces** a repeated rule
  rather than merging it — one block naming all three would have silently deleted the
  platform-free boundaries those blocks exist to enforce.

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

**Status: DONE 2026-08-26**, deployed `2c19cf17`. 349 tests, typecheck and lint clean.
Domain rules live in CLAUDE.md §8; the decisions in ADR-023, ADR-025.

**Goal:** the feature the site is actually for — trailing weekly high/low bands — plus
enchanted-book merging as a second craft type.

### What shipped

- **`packages/core/src/convert.ts`** — one cheapest-path solver over a conversion graph,
  serving both anvil chains and multi-step compaction (ADR-023). No discriminated union:
  `2^k` emerges from composing k edges of ratio 2, so Sharpness 1→7 is six edges and 64
  falls out of the multiplication. Multiplicative shortest path, Dijkstra-safe because
  `inputPerOutput ≥ 1` means traversing an edge never lowers cost — so a cyclic recipe
  graph cannot spiral.
- **`packages/core/src/anvil.ts`** + migration `0008` (`kind` discriminator) — 620 edges
  derived from 155 families **at runtime by the daily cron**, never seeded in a migration:
  a hardcoded list would stale the catalogue, and `INSERT ... SELECT FROM products` would
  put zero rows on a fresh database (ADR-024's replay property). All `verified = 0`.
- **Tier A gained the book level-endpoint clause** — 793 tags, of which 295 are book
  endpoints. The `kind = 'compact'` filter in `ingest.ts` is load-bearing: unioning anvil
  recipe tags the way compaction tags are unioned would promote all 777 book tags.
- **`packages/core/src/bands.ts`** + `GET /api/bands/:tag` and `GET /api/bands` —
  percentile bands with hit-rates, ranked by volume-and-feasibility-adjusted profit/day,
  precomputed to `bands:default:v1` by the hourly cron. No migration needed: `hourly`
  already carried `bid_min/avg/max` and `ask_min/avg/max`.
- `/api/scan` merges compaction and anvil into **one** ranked list — they compete for the
  same capital, so separate leaderboards would hide the comparison that matters.

### What the build taught us, kept because it will be re-derived wrong otherwise

- **An enormous merge margin means the merge does not exist** (ADR-025). Looting IV asks
  50,000 and Looting V asks 172,816,195 — Looting V comes from a minigame, not an anvil.
  Edges above an implied ratio of 3 are withheld and the family re-targets the highest
  rung a merge can reach. 45 of 320 judgeable edges are gated.
- **Enchant levels are not what they look like.** Three level-0 books exist; eleven
  families span levels 1–10 (nine merges, not the familiar six); `FEATHER_FALLING` lists
  1–10 then jumps to 20. Adjacency, not `min..max`, is what keeps the chain honest.
- **The band and the touch are different statistics.** The band is a percentile of hourly
  _averages_ — a price you can rest an order at. A touch is tested against the hour's
  _extreme_ — whether price actually got there. Confusing them is the subtle failure.

**Done when:** ~~a band endpoint returns buy/sell bands with hit-rates for any Tier A
tag~~ (code complete; data-gated until 24h of `hourly` accumulates — see TODO.md);
~~the anvil scan ranks merges by profit-per-day with fill feasibility attached~~ (met);
~~the cheapest-path solver picks the right entry level on a hand-computed case~~ (met);
~~and `ENCHANTED_SUGAR_CANE` no longer reports a 3,000% margin~~ (met — now −0.1%).

---

## Phase 5 — Frontend

**Status: BUILT, NOT SIGNED OFF — 2026-08-26.** All six views are implemented on branch
`v0.5`, `npm run typecheck` and `npm run lint` are clean, and every non-negotiable UI rule
below is enforced structurally rather than by convention. What is missing is the
_verification_: none of the three Done-when gates has been run, because the local toolchain
cannot produce a build. See ADR-029 — Smart App Control blocks Vite 8's unsigned Rolldown
binding, which takes out `npm run build`, `npm test` and `npm run dev:web` together. The fix
is a machine setting and a reboot, not a code change; until then the last green test run is
Phase 4.5's 349.

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

### What shipped

| View                 | Route             | File                                |
| -------------------- | ----------------- | ----------------------------------- |
| Band table (landing) | `/`               | `web/src/views/BandsView.tsx`       |
| Band detail          | `/bands/:tag`     | `web/src/views/BandDetailView.tsx`  |
| Scan table           | `/scan`           | `web/src/views/ScanView.tsx`        |
| Craft detail         | `/craft/:baseTag` | `web/src/views/CraftDetailView.tsx` |
| Item page            | `/item/:tag`      | `web/src/views/ItemDetailView.tsx`  |
| Settings drawer      | (layout)          | `web/src/app/SettingsDrawer.tsx`    |

Bands sit at `/` rather than `/bands` because they are what someone opens before setting up
orders for the evening; the ranked craft scan is the secondary view. A seventh route,
`/items` (`ItemsView.tsx`), was added beyond the plan as a searchable index — the item page
is useless without a way to reach a tag by name.

**How the non-negotiables are held.** Not by review discipline:

- `ui/pairedColumns.ts` makes a lone margin column or a lone band column
  **unconstructible** — the factory returns a tuple of two and nothing else builds one
  (ADR-027). Adjacency survives the sub-640px collapse to `display: grid`.
- `ScanTable.tsx` marks unverified recipes on the recipe cell itself, and `CraftFlags.tsx`
  deliberately drops `unverified-recipe` from the chip row so the marking is not duplicated
  into noise. All 43 recipes ship unverified, so this is the default path, not an edge case.
- `BandTable.tsx` renders `n=Nw` inline whenever `weekCount < 4`; `ItemDetailView.tsx` does
  the same for a volatility computed over a short window.
- `DataAge` lives in `Header.tsx`, so it is on every route and never in a tooltip.
- `Footer.tsx` carries the SkyCofl attribution and the Hypixel/Mojang disclaimer in the
  layout rather than a view, so no route can ship without them.
- `charts/lazy.tsx` keeps Recharts off the landing route entirely (ADR-028).

### What remains

Only verification — no known missing feature:

1. Lighthouse performance >90 on the landing route.
2. A real 375px pass, not a static reading of the Tailwind breakpoints.
3. The comprehension check on "crafts/day".

All three need a build, so all three are blocked on ADR-029.

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
  trust — and with a 30-day window it is now _exactly_ the span we retain, so a backtest
  is the natural validation of the band strategy rather than a separate data problem.

Deliberately **not** doing: user accounts, a mod, a mobile app, real-money anything.

---

## Phase 8 — Publish the open dataset

**Goal:** the aggregated bazaar history, free and open, as bulk dumps.
**Effort:** 2 evenings, but gated behind a month of proven collection

**Re-scoped 2026-08-26: this is a rolling 30-day window, not an accumulating archive.**
The retention cap (CLAUDE.md §3) means we never hold more than a month, so what gets
published is "the last 30 days, refreshed daily" — a _current_ dataset rather than a
historical one. Two consequences worth being honest about up front:

- **We are not the place to get 2024 bazaar history.** Anyone wanting a long series still
  needs Coflnet or their own collector. Say so in the README rather than letting people
  discover it after downloading.
- **Dated files stop being immutable in the useful sense.** A day's file is still frozen
  once written, but it _disappears_ 30 days later. The manifest must state the window, and
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

| Clause                                                     | Status                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No commercial use; features must be available to all users | **Cleared** — free, open, no tiers                                                 |
| Not for automated data collection at scale                 | Live risk. Stated example is player-stat polling; market data is arguably distinct |
| May not proxy the Public API to 3rd party developers       | Live risk, mitigated by the design below                                           |

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

| Item         | Cost                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| Workers Paid | already active                                                               |
| D1           | within paid inclusions with large headroom at Tier A volume                  |
| KV           | within inclusions                                                            |
| R2           | within 10 GB free **only if** the archive policy in CLAUDE.md §3 is followed |
| Queues       | within inclusions; unlocks Phase 7 alerts                                    |
| Domain       | already owned                                                                |

Marginal cost of this project is effectively zero. The binding constraint is no longer
money or platform limits — it is evening-hours and the discipline to not widen scope
just because the headroom exists.

If $5/mo is a blocker: move ingestion to a GitHub Actions cron writing to D1 over HTTP,
and keep the Worker on free. Real tradeoff — scheduled Actions run late by 5–20 minutes,
get disabled after 60 days of repo inactivity, and split your logic across two runtimes.
Worth it only if the $5 genuinely isn't available.
