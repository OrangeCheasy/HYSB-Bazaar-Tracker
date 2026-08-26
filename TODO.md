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

## Do these, in this order

### 1. Commit and push — production is running uncommitted code

Everything above is **deployed but not committed**. The working tree holds the retention
changes (`rollup.ts`, `archive.ts`, `db/prune.ts`), migration `0006`, two new test files,
and the doc rewrites. Until this is committed, `main` does not describe what is live and a
rollback has nothing to roll back to.

### 2. The migration chain cannot be replayed on a clean database

Found while fixing local dev, and it is worse than a local-dev annoyance.

`0004_fix_remote_0001_drift.sql` unconditionally runs `ALTER TABLE snapshots ADD COLUMN
ask_depth_1pct` and seven siblings. On any fresh database `0002` has *already* added those
columns, so `0004` dies on `duplicate column name: ask_depth_1pct`. `0005` has the same
shape against `products`/`runs`. Both exist purely to repair a one-time drift on the
**remote** database, caused by editing `0001` after it had been applied.

Reproduced from scratch this session: `0001 → 0002 → 0003` apply, `0004` fails.

Consequences beyond dev convenience:
- No new environment can be built from migrations — which is exactly what ROADMAP Phase 6
  asks for (a preview Worker environment, and CI running migrations before deploy)
- Disaster recovery has no path back to a working schema
- A second dev machine cannot get started

Local was unblocked by inserting `0004`/`0005` into local `d1_migrations` by hand, since a
fresh `0001`+`0002` already produces the columns they add. That is a workaround, not a fix.

Two real options, and this is a judgement call worth making deliberately:
- **Squash to a baseline.** Replace `0001`–`0005` with one migration that creates the
  current schema, and reconcile remote's `d1_migrations` bookkeeping to match. Cleanest
  end state, needs care against production.
- **Neuter `0004`/`0005`** into comment-only files. They have no remaining purpose — the
  drift they repaired exists on exactly one database and is already repaired. Cheap, but it
  means editing applied migrations, which is the specific act that caused this mess and
  which CLAUDE.md section 5 forbids.

I did not pick one unilaterally: both touch production bookkeeping, and the forbidden-by-
CLAUDE.md option may still be the right call given those files are provably dead.

### 3. Start Phase 2's 48-hour clock

The blocker is cleared — `runs` shows zero errors across every kind including `prune`. The
clock starts from **2026-08-26 ~03:00 UTC**, so the earliest close is **2026-08-28 03:00
UTC**, provided nothing errors in between.

The remaining Done-when clause after that is "pruning has actually deleted something."
Today's prune deleted 0 legitimately — nothing is past retention. `snapshots` crosses 7
days on **~2026-09-01**, which is the earliest that clause can close.

### 4. Rotate the API token

Carried over. A token was pasted into a chat session on 2026-08-25 in plaintext. The token
in `.env.local` works and `.env.*` is correctly gitignored, but I cannot tell whether it is
the rotated one. If it is, delete this item.

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
npm run db:migrate:local   # see item 2 — fails on a fresh DB at 0004 until that is fixed
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
  daily", which ADR-021 superseded. It is inside an applied migration, so leave it unless
  item 2 squashes the chain anyway.
- The Python reference tool (`bzapi.py`, `bzcraft.py`, `model.py`, `config.json`) still
  lives at repo root rather than `reference/bzcraft/`. Harmless; the ADRs cite root paths.
- Backup tags `backup/old-main-dc71bff` and `backup/old-phase0-7a90a97` from the orphaned-
  history repair still exist, as does the stale local branch `v0.1/phase0`. Delete when
  you're confident.
