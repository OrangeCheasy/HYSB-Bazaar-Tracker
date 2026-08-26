# TODO — resume here

Rewritten 2026-08-26, replacing the pre-verification version. Delete this file once
everything below is done; it's a session handoff note, not a permanent doc
(CLAUDE.md/ROADMAP.md/DECISIONS.md are the permanent ones).

## Verified working — don't re-investigate these

Checked against production on 2026-08-25 ~22:55 UTC, deployed version `59e5b9af`
(= commit `f76ad2c`, "doubling fixes"). Repo clean and in sync with `origin/main`.

- **Phase 4 is deployed and its Done-when is met.** Warm `/api/scan` is **4ms median,
  5ms max** server-side `wallTime` against a <50ms target. All seven endpoints 200 with
  correct `meta`; unknown tag 404s.
- **`precompute` works.** First successful run 22:07:10 UTC (1256ms). `scan:default:v1`
  is 66,194 bytes in KV, `/api/scan` reports `source: "kv"` with 42 scored crafts. The
  stale `no-base-data` payload a dev session left is overwritten.
- **Tick quantization works.** 5,511 rows on exact 300s boundaries since deploy.
- **Scan parameter validation works.** All seven params 400 with a message naming the
  parameter, on both `/api/scan` and `/api/craft/:tag`.
- **Double cron firing has stopped.** Ingests/hour: `18h=21, 19h=24, 20h=24, 21h=20,
  22h=12`. Back to exactly 12.
- **Deployed bindings match `wrangler.jsonc` exactly** — the old stray `bazaar_archive`
  drift is gone.
- **R2 archive is healthy** and CLAUDE.md's sizing numbers re-validated within 1%
  (3.44 MB raw / 485 KB gzipped / 7.3x).

One gotcha that cost time: `wrangler kv key list` and `r2 object get` **default to local
state in wrangler v4**. Without `--remote` they report an empty namespace and a 0-byte
object even when production is fine.

## Do these, in this order

### 1. Implement the 30-day retention policy

The policy is now in CLAUDE.md §3; the code does not implement it yet. Three concrete
gaps, all in the daily cron path:

- `src/worker/rollup.ts:26` — `HOURLY_RETENTION_SECONDS = 90 * DAY`, must become `30 * DAY`
- `daily` **is never pruned at all**. Add `DAILY_RETENTION_SECONDS = 30 * DAY` and a third
  `boundedDelete` call alongside the existing two
- `src/worker/archive.ts` — `FULL_RETENTION_DAYS = 14` correctly downgrades day 15 to
  `quick_status`, but **nothing ever deletes an R2 object**. Add the 30-day delete; it is
  what makes the archive flat at ~2.3 GB instead of growing forever

`SNAPSHOT_RETENTION_SECONDS = 7 * DAY` is already correct — leave it.

Note the first run after this ships will delete a lot at once. `boundedDelete` already
caps batches and reports `moreRemaining`, so it will spread across nights rather than
blowing the query limit — but check `runs` for `moreRemaining` warnings for a few days.

### 2. Fix the SUGAR_CANE recipe — it is wrong in production right now

`/api/scan` currently ranks `SUGAR_CANE → ENCHANTED_SUGAR_CANE` **first**, at
**1.77 billion profit/day**, 25x the #2 item. The recipe is seeded as a single 160:1 step.

Evidence it is wrong, not just optimistic: implied price ratio
(`ench_bid / (ratio × base_ask)`) across all 42 recipes lands between **0.04 and 1.23** for
41 of them — exactly the sub-160x compression CLAUDE.md §8 predicts. SUGAR_CANE is
**29.05**, a 24x gap to the next value.

Cause: `ENCHANTED_SUGAR_CANE` is a tier-2 enchant (160 × `ENCHANTED_SUGAR`, itself
160 × `SUGAR`), so 160:1 off raw sugar cane is the wrong path. **Confirm the real ratio
against a crafting grid before changing it** — CLAUDE.md §8 is explicit that ratios cannot
be validated automatically, and my arithmetic is not a substitute for looking.

The engine is not at fault: it already flags this row `["unverified-recipe",
"implausible-margin", "wide-spread"]`. The safety net fired. What is missing is anything
that stops a flagged row from ranking first.

Two options, and they are not exclusive: fix the ratio now as a one-line seed change, and
fix it properly in Phase 4.5 Part A where the cheapest-path solver handles tier-2 chains
generally. The solver is the real fix; the seed change stops production lying today.

**Also: 0 of 42 recipes are `verified`.** That is fine while nothing renders them, but
Phase 5 ships the unverified marking as a launch-critical feature, not an edge case.

### 3. Decide what to do with the doubled data — still outstanding

This was recommended in the previous TODO and **was not done**. Current state:

- `snapshots`: 48,597 rows, only **28,056 distinct (tag, tick)** — ~20,541 duplicates
- `hourly`: `samples` reads **24** on 4,272 rows, 20 on 2,136, 18 on 2,136, where the
  truth is at most 12

Recommendation is unchanged: **delete it and start clean.** It is ~4 hours of day-one
data, and `hourly` is retained for 30 days, so carrying a knowingly-wrong `samples` in it
poisons the one field that tells the API when not to trust a row (CLAUDE.md §3b).

```bash
npx wrangler d1 execute bazaar --remote --command="DELETE FROM hourly; DELETE FROM snapshots;"
```

Leave `products` and `recipes` alone. The ~51k deletes are not worth worrying about
against the 50M/month allowance.

If you would rather keep it, write down that `samples` for 2026-08-25 18:00–21:00 is
inflated 2x, because nothing in the schema will tell you later.

### 4. Confirm the 04:23 prune runs clean

`/api/status` still reports `prune: {ok: false, error: "not implemented"}`. That row is
**stale, from 04:23 UTC under the old code** — pruning is implemented and wired into
`runDailyRollup` (`rollup.ts:192-242`). The next daily cron overwrites it.

This is the last `runs` kind still showing an error, so Phase 2's "zero errors" cannot be
declared until it goes green. Check after the next 04:23 UTC run.

Separately: "pruning has actually deleted something" cannot be satisfied until `snapshots`
crosses 7 days old — earliest **~2026-09-01** — unless step 1 ships first, in which case
the 30-day `hourly`/`daily` prunes will have nothing to delete either for a while. Expect
this Done-when clause to close in September regardless.

### 5. Then start Phase 2's 48-hour clock

It only counts once `runs` shows zero errors across **every** kind, including prune.
Earliest plausible start is the morning of 2026-08-26 after step 4 goes green.

### 6. Rotate the API token

Carried over from the previous TODO and still listed there as outstanding: a token was
pasted into a chat session on 2026-08-25 in plaintext. The token currently in `.env.local`
works and `.env.*` is correctly gitignored, but I cannot tell from here whether it is the
rotated one. If it is, delete this item.

## Then — Phase 4.5

New phase, added 2026-08-26: weekly bands and anvil book merges. See `docs/ROADMAP.md`
Phase 4.5 for build order and `PROMPTS.MD` for the three session prompts. Read CLAUDE.md
§8's two new subsections before starting — the domain rules live there.

Build order matters: Part A (the conversion graph) is a hard dependency of both the anvil
chains and the tier-2 compaction fix in step 2 above.

Watch for the one bug most likely to ship silently: a buy order competes at **`bid`** and a
sell offer at **`ask`** (CLAUDE.md §1). Deriving the low band from the ask side inverts the
strategy and produces orders that never fill. Write that test first.

## Phase 3 — deferred, and now bounded

Backfill is still deliberately skipped (ADR-017), but the 30-day cap **re-scoped** it:
fetching anything older than 30 days is now pointless because the prune deletes it. What
survives is reaching a full 30-day window immediately rather than waiting a month — which
matters more than before, because the band's hit-rate needs 4 weeks to mean anything.

`scripts/backfill.ts` is still a 38-line stub whose header comment says "Phase 6" — fix
that comment when you build it.

## Local dev environment, if this is a fresh clone/machine

`.wrangler/` (local D1 + R2 state) and `node_modules/` are both gitignored — a fresh
checkout starts with neither.

```bash
npm install
npm run db:migrate:local   # applies every migration to a fresh local D1
npm run build              # dist/client must exist for wrangler dev's assets binding
```

Local and remote D1 are entirely separate databases (CLAUDE.md §3). Remember `--remote` on
every `wrangler kv`/`r2` command or you will be inspecting empty local state.

## Smaller things noticed along the way, not urgent

- CLAUDE.md §2's Tier A figures were measured against a 150-tag recipe-only definition;
  they have been rewritten for the ~784-tag definition that includes book level-endpoints,
  but those new numbers are **projections, not measurements**. Re-measure once step 1 has
  been running a week, the way Phase 0.5 replaced the originals.
- `/api/item/*` serves data stamped `generatedAt: 21:00, staleAfter: 22:00` when queried at
  22:55 — already past its own staleness marker. It reads `hourly`, which only advances at
  :07, so item pages run 1–2h behind while `snapshots` are 5 minutes fresh. Honest, but
  worth a decision before Phase 5 puts charts in front of people.
- The Python reference tool (`bzapi.py`, `bzcraft.py`, `model.py`, `config.json`) still
  lives at repo root rather than `reference/bzcraft/`. Harmless; the ADRs cite the root
  paths. Structural tidiness only.
- `git` note: this clone briefly had an orphaned history (the repo was recreated when
  `HYSB-BazaarTracker` became `HYSB-BazzarTracker`, so `git pull` refused unrelated
  histories). Resolved by resetting to `origin/main`; backup tags `backup/old-main-dc71bff`
  and `backup/old-phase0-7a90a97` still exist and can be deleted once you're confident.
  The stale local branch `v0.1/phase0` also points at that dead history.
