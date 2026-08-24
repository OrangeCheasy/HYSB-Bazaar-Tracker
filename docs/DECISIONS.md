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

Hypixel's `buyPrice` is what *you pay to instant-buy* — the lowest sell offer. The names
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
