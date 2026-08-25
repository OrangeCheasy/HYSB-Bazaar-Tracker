# TODO — resume here

Rewritten 2026-08-25 evening, replacing the pre-deploy version. Delete this file once
everything below is done; it's a session handoff note, not a permanent doc
(CLAUDE.md/ROADMAP.md/DECISIONS.md are the permanent ones).

## Done since the last note

The Cloudflare setup that was blocked on auth is finished, and verified against the
remote database rather than assumed:

- `wrangler` is authenticated (`CLOUDFLARE_API_TOKEN` in the environment).
- `bazaar-archive` R2 bucket exists and holds real per-tick objects
  (`archive/2026-08-25/1815.json.gz`, `1820`, `1825`, …).
- Remote D1 is migrated: `recipes` = 42 rows, `products` = 2,136, `snapshots` = 38,076,
  `hourly` = 8,043.
- The Worker is deployed (version `fbb5f89f`, 2026-08-25 18:10 UTC, 100% traffic) and
  its three cron schedules are registered (`*/5`, `7 * * * *`, `23 4 * * *`).
- Ingest and rollup have recorded **zero** errors since that deploy — the last ingest
  error was 18:10:05, the last rollup error 18:07:05, i.e. the deploy is what fixed them.

## Priority 0 — two things are wrong in production right now

### 1. Phase 4 is not deployed, and precompute fails every hour because of it

`main` is at `34797a3 db setup`. The Phase 4 work — the API layer and the real
`precompute.ts` — lives only on `v0.4` (`077099d`, `5286f17`), which has never been
deployed. So production is running the old precompute stub:

```
SELECT kind, COUNT(*), SUM(error IS NOT NULL) FROM runs GROUP BY kind
  precompute   40 runs   40 errors   -- all "not implemented"
```

Consequences, in order of what they block:

- `scan:default:v1` has **never** been written to KV. `/api/scan` therefore falls
  through to a live D1 compute on every request (`src/worker/api/scan.ts:38` handles
  this correctly — it is a fallback, not a bug), which means Phase 4's Done-when
  ("default scan responds in <50ms warm") cannot be measured yet.
- `runs` can never show a clean hour, so Phase 2's 48-hour zero-error window cannot
  start. Fixing this is a prerequisite for closing Phase 2, not just Phase 4.

**Action:** merge `v0.4` into `main` and deploy, then confirm `precompute` records a
success and the KV key appears. Local gates are green as of this note: `npm test` 210
passing across 20 files, `npm run typecheck` clean.

### 2. Every cron is firing twice, ~54 seconds apart

Started exactly at the 18:10 deploy. Ingest runs per hour, from `runs`:

```
17:00  12    <- correct
18:00  21    <- deploy at 18:10
19:00  24    <- doubled
20:00  24
```

Each 5-minute tick produces two full ingests: e.g. 21:15:05 (1,687ms) and 21:15:59
(3,963ms), both writing 4,272 rows, both recorded as successes. `snapshots` confirms it
is two real rows per tag per tick, not double-counted logging — two distinct `ts` values
54s apart, 501 rows each.

Why it matters:

- Doubles D1 rows written against the 50M/month included allowance, and doubles
  `snapshots` growth against the measured 44 MB steady state in CLAUDE.md section 3.
- Corrupts the shape of the data, quietly. `hourly.samples` will read 24 instead of 12,
  and the samples are spaced 54s / 4m06s / 54s rather than evenly at 5 minutes. Section
  3b's whole argument is that `samples` is the honesty signal — an inflated one is worse
  than a missing one.
- R2 is unaffected: both firings map to the same `HHmm` key, so the second overwrites
  the first.

What has been ruled out already:

- Not a second Worker. The account has two scripts (`hysb-bazaartracker`, `liamthemo`)
  and only the first has any cron schedules — exactly the expected three, no duplicates.
- Not a gradual-deployment version split. One version at 100%.
- Not double-recording in our own code. `runIngest` calls `recordRun` once per run, and
  the two runs have different `started_at` and different durations.

**Next diagnostic:** Workers observability logs for the `scheduled` invocations. If both
deliveries carry the same `scheduledTime`, it is platform-level double delivery and
belongs in a Cloudflare support ticket; if they differ, something is registering a
schedule outside `wrangler.jsonc`. Until it is understood, treat every ingest-volume and
`samples` number from after 2026-08-25 18:10 as suspect.

## Then — close out Phase 2

Its Done-when needs all of: 48 hours unattended, `runs` shows zero errors, pruning has
actually deleted something, R2 has real objects, and a deliberate ingest break was
recorded as a failure.

- R2 objects: done.
- Deliberate break recorded: done locally, and production's 405 pre-deploy ingest errors
  are the same mechanism working unintentionally.
- Pruning: cannot fire until `snapshots` crosses 7 days old — earliest ~2026-09-01.
- 48 clean hours: **starts only once both Priority 0 items are fixed.** Zero errors means
  zero, including precompute.

## Phase 3 — deliberately deferred, don't re-litigate it

Backfill is skipped on purpose, not forgotten: Coflnet's history keeps, our own does not.
Reasoning is written up in `docs/DECISIONS.md` ADR-017 and summarised in ROADMAP Phase 3.
`scripts/backfill.ts` is still a 38-line stub whose header comment says "Phase 6" — fix
that comment when you build it. Revisit before Phase 5 ships hour-of-day charts.

## Local dev environment, if this is a fresh clone/machine

`.wrangler/` (local D1 + R2 state) and `node_modules/` are both gitignored — a fresh
checkout starts with neither. Before `npm run dev` will work locally:

```bash
npm install
npm run db:migrate:local   # applies every migration to a fresh local D1
npm run build              # dist/client must exist for wrangler dev's assets binding
```

Local and remote D1 are entirely separate databases (CLAUDE.md section 3).

## Smaller things noticed along the way, not urgent

- CLAUDE.md section 2's Tier A growth figure (~350 MB/year) was measured against a
  150-tag (recipe-only) definition during Phase 0.5, but the code implements the broader
  "recipe tags + top 500 by volume" definition — production is carrying 501 Tier A tags
  per tick. Re-measure once there is a week of real data and replace the estimate, the
  way Phase 0.5 replaced the originals. (Note the double-cron bug above inflates any
  growth rate measured after 2026-08-25 18:10 by 2x — fix that first or the new number
  will be wrong too.)
- The Python reference tool (`bzapi.py`, `bzcraft.py`, `model.py`, `config.json`) still
  lives at repo root instead of `reference/bzcraft/` as `PROMPTS.MD`'s Phase 1 prompt
  originally specified. Harmless — `docs/DECISIONS.md`'s ADRs already cite the root
  paths — just a structural tidiness item if you ever care.
- ROADMAP Phase 2's tier-assignment line has been corrected to match what was built;
  it previously said recipe tags only.
