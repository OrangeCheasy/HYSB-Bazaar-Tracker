# TODO — resume here

Rewritten 2026-08-26 ~05:00 UTC, after Phase 4.5 merged (`f9fd461`, PR #8). Delete this
file once everything below is done; it's a session handoff note, not a permanent doc
(CLAUDE.md / ROADMAP.md / DECISIONS.md are the permanent ones).

**Phases 0–4.5 are built, deployed and verified.** Next build phase is 5 (frontend).
Deployed version `2c19cf17`; 349 tests, typecheck and lint clean; all four cron kinds
report `ok=true`.

## Waiting on the clock — nothing to do but check

### 1. Bands go live around 2026-08-26 22:00 UTC

The last open Phase 4.5 Done-when clause. `computeBand` needs 24 hourly rows and only 7
exist, because the contaminated pre-22:00 data was deleted on 2026-08-25. Until then
`/api/bands` correctly returns `data: []` and `/api/bands/COAL` correctly returns
`422 insufficient-data` — the plumbing is proven end-to-end against seeded data, only the
history is missing.

Check after 22:00 UTC:

```bash
curl -s https://bazaar.liamthemo.com/api/bands | head -c 400
curl -s https://bazaar.liamthemo.com/api/bands/COAL
```

Expect real bands with hit-rates, `weekCount: 1`, and a `short-history` flag. The
`short-history` flag stays until **2026-09-22** (4 weeks of history) — that is correct, not
a bug.

### 2. Phase 2's 48-hour clock

Started **2026-08-26 ~03:00 UTC**; earliest close **2026-08-28 03:00 UTC**, provided
nothing errors in between.

The remaining clause after that is "pruning has actually deleted something." Prune has run
clean but deleted 0 rows, legitimately — nothing is past retention yet. `snapshots` crosses
7 days on **~2026-09-01**, the earliest that clause can close.

## Decide before Phase 5 ships UI

### 3. Flagged rows still rank above unflagged ones

**59% of scored scan rows carry `implausible-margin`** (52 of 88 at last count; 33 of 46
anvil rows). ADR-025's merge gate removed the worst — the 2.88-billion Looting row is gone
and the top ten now sit at −1% to 0% floor margins — but nothing _demotes_ a flagged row.
It only marks it.

Three options, and it is a product call, not a technical one:

- **Demote** flagged rows below unflagged ones (my recommendation — keeps "this looks too
  good, here is why" visible rather than hiding it)
- **Filter** them out entirely
- **Mark loudly** and leave the ranking alone

Whichever is chosen, ROADMAP Phase 5's rule stands: a margin never renders without its
fill-feasibility number, and a band never renders without its hit-rate.

### 4. Every recipe is unverified

**0 of 663** — 43 compaction, 620 anvil. Fine while nothing renders them, but Phase 5 ships
the unverified marking as a launch-critical feature rather than a rare edge case. Verifying
even the top 20 by profit/day would materially change what the site can claim.

Anvil ratios are arithmetic (`2^k`), but whether every rung _actually merges_ is not — that
is the unverified part, and ADR-025's gate narrows the damage without replacing
verification.

### 5. `/api/item/*` runs 1–2 hours behind

It reads `hourly`, which only advances at :07, while `snapshots` are 5 minutes fresh. So a
response can be past its own `staleAfter` late in an hour. Honest, but worth a decision
before Phase 5 puts charts in front of people.

## Smaller things, not urgent

- **`/api/recipes` returns 663 rows**, up from 42, since anvil edges are genuinely recipes.
  A `?kind=` filter is cheap if that payload growth matters.
- **Non-default scan params are slow** — `?tax=0.02` takes ~3.9s (144 rows × 2 series
  queries). Default params hit KV and stay fast. Worth knowing before a settings drawer
  changes params on every keystroke; the fix is the same batching `runBandScan` uses.
- **The 3–10 implied-ratio band is genuinely ambiguous** for merge gating. A real 4× merge
  would currently be suppressed and we would not know. `detectMergeGates` returns the gated
  set with its ratios so "why is this family capped at level 4" stays answerable — revisit
  the threshold once merges start being verified by hand.
- **The anvil coin/XP fee is unverified.** Modelled as an input defaulting to 0, and any
  path charging it raises `unverified-step-cost`. Confirm it in-game; if non-zero it enters
  the cost side once per merge, so `2^(M-L) − 1` merges, not one.
- **CLAUDE.md §2's Tier A tag counts are now measured** (793 tags / 295 endpoints), but the
  MB figures beside them are still projections. Re-measure after a week of real data, the
  way Phase 0.5 replaced the originals.
- `ENCHANTED_QUARTZ -> ENCHANTED_QUARTZ_BLOCK` carries `implausible-margin` while its
  implied price ratio (0.8) is unremarkable — probably a threshold firing on a genuinely
  wide spread. Worth one look while the flag vocabulary is still being tuned.
- `0001_initial.sql`'s comment on `products.tier` still says "pruned to 90d then rolled to
  daily", superseded by ADR-021. A comment inside an applied migration, changing no
  behaviour — left alone deliberately rather than widening ADR-024's exception.
- The Python reference tool (`bzapi.py`, `bzcraft.py`, `model.py`, `config.json`) still
  lives at repo root rather than `reference/bzcraft/`. Harmless; the ADRs cite root paths.
- Backup tags `backup/old-main-dc71bff` and `backup/old-phase0-7a90a97` from the
  orphaned-history repair still exist, as do local branches `v0.1/phase0`, `v0.4.5` and
  `v0.5`. Delete when you're confident.

## Phase 3 — deferred, and bounded

Backfill is still deliberately skipped (ADR-017), but the 30-day cap re-scoped it: fetching
older than 30 days is pointless because the prune deletes it. What survives is reaching a
full 30-day window immediately instead of waiting a month — which matters **more** now that
bands exist, because the hit-rate needs 4 weeks before it means anything, and that is
otherwise 2026-09-22.

`scripts/backfill.ts` is still a 38-line stub whose header comment says "Phase 6" — fix
that comment when you build it.

## Local dev environment

```bash
npm install
npm run db:migrate:local   # replays cleanly from scratch as of ADR-024
npm run build              # dist/client must exist for wrangler dev's assets binding
```

Local and remote D1 are entirely separate databases (CLAUDE.md §3).

Three things that cost time and will cost it again:

- **`wrangler kv key list` and `r2 object get` default to LOCAL state in wrangler v4.**
  Without `--remote` they report an empty namespace and a 0-byte object while production is
  perfectly healthy.
- **`wrangler dev --remote --test-scheduled` runs a cron against PRODUCTION bindings.** It
  is the only way to exercise the daily job without waiting for 04:23, and it is how
  `prune`, the anvil sync and the band precompute were each confirmed — but it writes to
  the real database.
- **Killing a `wrangler dev` leaves `workerd` holding the local D1 file.** Stop the
  background task itself, or the state directory cannot be moved. To test a fresh migration
  replay without touching your working state, use
  `wrangler d1 migrations apply bazaar --local --persist-to <tmpdir>`.
