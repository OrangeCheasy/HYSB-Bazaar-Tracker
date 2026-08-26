# TODO — resume here

Rewritten 2026-08-26 ~03:00 UTC after working the previous list to completion. Delete this
file once everything below is done; it's a session handoff note, not a permanent doc
(CLAUDE.md/ROADMAP.md/DECISIONS.md are the permanent ones).

## Done and verified this session — do not redo

Deployed version `795c2c5d`. All four cron kinds report `ok=true, error=null` on
`/api/status` for the first time.

- **30-day retention is implemented and proven.** `HOURLY_RETENTION_SECONDS` 90d → 30d,
  new `DAILY_RETENTION_SECONDS` (the `daily` table was **never pruned at all** before),
  and a new `pruneArchiveExpired` in `archive.ts` that deletes R2 objects past 30 days —
  the missing piece that made the archive grow forever despite the 14-day downgrade.
  Verified end-to-end against a seeded local DB: 8d snapshot deleted / 2d kept, 31d hourly
  deleted / 20d kept, 35d daily deleted / 10d kept.
- **SUGAR_CANE is fixed** (migration `0006`, applied local + remote). It is now the
  two-step chain the price data supports. The 1.77-billion-profit/day row is gone from
  both the KV and live-D1 scan paths. The recipe table now has 43 rows.
- **All recipe ratios re-checked.** Highest implied price ratio is now **1.256**
  (ENDER_PEARL), down from 29.05. Every one of the 43 sits inside the 0.04–1.26 band
  CLAUDE.md section 8 predicts, and all 43 have live price data. SUGAR_CANE was the only
  structurally wrong recipe, not the first of many.
- **Doubled data is gone**, deleted surgically rather than wholesale: 43,086 off-boundary
  `snapshots` and 8,544 pre-22:00 `hourly` rows. `MAX(samples)` is back to 12 and
  duplicate (tag, tick) pairs are zero. The blanket `DELETE FROM hourly; DELETE FROM
  snapshots` the last note recommended would also have destroyed the ~4.8 hours of clean
  data that had accumulated since — 10,179 hourly rows already reading samples=12.
- **`prune` runs clean in production.** The stale `error: "not implemented"` row from
  2026-08-25 04:23 is superseded: 449ms, 2,136 daily rows written, 0 deleted (correct —
  nothing is past retention yet). `daily` is populated for the first time.
- **No double-cron regression** after two deploys today. Steady 12 ingests/hour.
- 8 new tests (227 total, 22 files), typecheck clean.

One of those tests earned its keep immediately: the R2 delete originally advanced a
pagination cursor while deleting underneath it, which silently skipped ~40% of keys. The
fix re-lists from the start each round instead.

## Also done — migrations replay again (ADR-024)

The chain could not be rebuilt on a clean database: `0004`/`0005` were unconditional
`ADD COLUMN`s repairing a one-time drift on remote, and on any fresh database `0002` had
already added those columns, so a replay died on `duplicate column name:
ask_depth_1pct`. That meant no preview environment, no second dev machine, no disaster
recovery, and ROADMAP Phase 6's "CI runs migrations then deploys" could never have worked.

- `0004`/`0005` are now comment-only files preserving their original statements and the
  reasoning. Safe because D1's bookkeeping is name-based — `d1_migrations (id, name
  UNIQUE, applied_at)`, no content hash — so already-migrated databases never re-read them.
  Verified before acting.
- A squash was the other option and was rejected: it edits five applied migrations instead
  of two *and* needs production bookkeeping rewritten by hand. Strictly more risk, same end
  state.
- **`0007_converge_indexes.sql`** fixes drift found on the way: production carried
  `idx_daily_day_ts` and `idx_runs_kind_started`, which appear in **no migration**, and
  lacked `idx_runs_started`, which `0001` creates. Someone had created indexes directly
  against production — the same failure as editing a migration, pointed the other way, and
  invisible until you try to build a second database. Each surviving index is now justified
  against a real query; `idx_runs_started` is dropped because none needs it.
  `idx_daily_day_ts` turns out to matter: the new 30-day `daily` prune scans
  `WHERE day_ts < cutoff` across all tags, which `daily`'s `(tag, day_ts)` primary key
  cannot serve.
- Verified: a from-scratch replay of all seven migrations now produces a database
  byte-identical to production across six tables, 43 recipes, and the same five indexes.
  `0007` applied to remote and local; production reports no pending migrations and all four
  run kinds still `ok=true`.

To check this property in future: `wrangler d1 migrations apply bazaar --local --persist-to
<tmpdir>` builds a database from scratch without touching your working state. CLAUDE.md
section 5 now asks for this after adding a migration.

## Do these, in this order

### 1. Commit and push

The migration-replay work above (`0004`, `0005`, `0007`, CLAUDE.md §5, ADR-024, this file)
is uncommitted. The previous batch landed as `cfb6326` on `v0.bugfix`.

### 2. Phase 2's 48-hour clock is running

Started **2026-08-26 ~03:00 UTC**; earliest close **2026-08-28 03:00 UTC**, provided
nothing errors in between. Timer is being tracked externally.

The remaining Done-when clause after that is "pruning has actually deleted something."
Today's prune deleted 0 legitimately — nothing is past retention yet. `snapshots` crosses 7
days on **~2026-09-01**, the earliest that clause can close.

## Then — Phase 4.5

Weekly bands and anvil book merges. `docs/ROADMAP.md` Phase 4.5 for build order,
`PROMPTS.MD` for the three session prompts, CLAUDE.md section 8 for the domain rules.

Part A (the conversion graph, ADR-023) is a hard dependency of both halves. It is also the
general fix for what migration `0006` patched by hand — `0006` stops production lying
today, it does not remove the need for a solver that prices multi-step chains properly.

The bug most likely to ship silently: a buy order competes at **`bid`**, a sell offer at
**`ask`** (CLAUDE.md section 1). Deriving the low band from the ask side inverts the
strategy and produces orders that never fill. Write that test first.

## Phase 3 — deferred, and now bounded

Backfill is still deliberately skipped (ADR-017), but the 30-day cap re-scoped it: fetching
older than 30 days is pointless because the prune deletes it. What survives is reaching a
full 30-day window immediately instead of waiting a month — which matters more than before,
since the band's hit-rate needs 4 weeks to mean anything.

`scripts/backfill.ts` is still a 38-line stub whose header comment says "Phase 6" — fix
that comment when you build it.

## Local dev environment

```bash
npm install
npm run db:migrate:local   # replays cleanly from scratch again as of ADR-024
npm run build              # dist/client must exist for wrangler dev's assets binding
```

Local and remote D1 are entirely separate databases (CLAUDE.md section 3).

Two things that cost time this session and will cost it again:
- **`wrangler kv key list` and `r2 object get` default to LOCAL state in wrangler v4.**
  Without `--remote` they report an empty namespace and a 0-byte object while production is
  perfectly healthy.
- `wrangler dev --remote --test-scheduled` will run a cron against **production** bindings.
  It is the only way to exercise the daily job without waiting for 04:23, and it is how
  `prune` was confirmed this session — but know that it writes to the real database.

## Smaller things noticed along the way, not urgent

- CLAUDE.md section 2's Tier A figures (~784 tags, 243 MB snapshots, 283 MB hourly) are
  **projections for the post-book tier rule, not measurements** — the book clause is not
  implemented yet. Re-measure once Phase 4.5 ships it, the way Phase 0.5 replaced the
  originals.
- `/api/item/*` serves data stamped `generatedAt` at the top of the last rolled-up hour,
  so it can be past its own `staleAfter` late in an hour. It reads `hourly`, which only
  advances at :07, while `snapshots` are 5 minutes fresh. Honest, but worth a decision
  before Phase 5 puts charts in front of people.
- `ENCHANTED_QUARTZ -> ENCHANTED_QUARTZ_BLOCK` carries an `implausible-margin` flag while
  its implied price ratio (0.8) is unremarkable. Probably a threshold firing on a genuinely
  wide spread rather than a bad ratio, but worth one look while the flag vocabulary is
  still being tuned.
- `0001_initial.sql`'s comment on `products.tier` still says "pruned to 90d then rolled to
  daily", which ADR-021 superseded. It is a comment inside an applied migration and changes
  no behaviour — left alone deliberately rather than widening ADR-024's exception.
- The Python reference tool (`bzapi.py`, `bzcraft.py`, `model.py`, `config.json`) still
  lives at repo root rather than `reference/bzcraft/`. Harmless; the ADRs cite root paths.
- Backup tags `backup/old-main-dc71bff` and `backup/old-phase0-7a90a97` from the orphaned-
  history repair still exist, as does the stale local branch `v0.1/phase0`. Delete when
  you're confident.
