# TODO — resume here

Rewritten 2026-08-25 evening, replacing the pre-deploy version. Delete this file once
everything below is done; it's a session handoff note, not a permanent doc
(CLAUDE.md/ROADMAP.md/DECISIONS.md are the permanent ones).

## Do these, in this order

1. **Review and ship the fixes.** Uncommitted in the working tree: tick-boundary stamping
   (`src/worker/ingest.ts`), scan parameter validation (`src/worker/scan.ts`,
   `api/scan.ts`, `api/craft.ts`), the `CACHE` binding change (`wrangler.jsonc`), ADR-018
   through ADR-020, and 9 new tests. `npm test` 219 passing, `npm run typecheck` clean.
   Commit, push, then deploy — the deployment history shows `wrangler` as the source for
   every deploy so far, so `npm run deploy` is the step that actually ships it, despite
   CLAUDE.md section 6 saying CI does this.

2. **Confirm the 22:07 precompute succeeded** (the first run under Phase 4 code):

   ```bash
   npx wrangler d1 execute bazaar --remote --command \
     "SELECT kind, datetime(started_at,'unixepoch'), duration_ms, error FROM runs \
      WHERE kind='precompute' ORDER BY id DESC LIMIT 3"
   ```

   Expect `error` to be NULL. Then check `/api/scan` returns `source: "kv"` with a fresh
   `generatedAt` and real analyses instead of 42x `no-base-data`.

3. **Decide what to do with the doubled data.** Every row currently in the database was
   written during the double-cron window: 43,086 snapshot rows covering only 22,545
   distinct (tag, tick) pairs — about 20,500 duplicates — and all 8,043 `hourly` rows,
   with `samples` reading up to 24 where the truth is 12.

   Recommendation: **delete it and start clean.** It is roughly four hours of day-one
   data, and `hourly` is the table kept forever — carrying a permanently wrong `samples`
   in it is worse than a four-hour hole at the very start of history, because `samples`
   is the signal that tells the API when not to trust a row (CLAUDE.md section 3b).

   ```bash
   npx wrangler d1 execute bazaar --remote --command "DELETE FROM hourly; DELETE FROM snapshots;"
   ```

   Do this **after** step 1 is deployed, so the next tick refills with quantized
   timestamps. Leave `products` and `recipes` alone. The ~51k deletes count against the
   50M rows/month allowance and are not worth worrying about.

   If you would rather keep it, the data is not wrong — averages are unbiased, some
   minutes just carry double weight — but write down that `samples` for 2026-08-25
   18:00-21:00 is inflated 2x, because nothing in the schema will tell you later.

4. **Watch for the doubling coming back after step 1's deploy.** It appeared at one
   deploy and vanished ~3.5 hours later without one, so a redeploy is a plausible trigger
   and nothing is understood well enough to rule it out. Twelve ingests per hour is
   correct:

   ```bash
   npx wrangler d1 execute bazaar --remote --command \
     "SELECT strftime('%Y-%m-%d %H', started_at,'unixepoch') hr, COUNT(*) n FROM runs \
      WHERE kind='ingest' GROUP BY hr ORDER BY hr DESC LIMIT 6"
   ```

   If it returns 24 again, the quantization fix means the data survives it intact — but
   open a Cloudflare support ticket citing the request-ID pairs in section 2 below.

5. **Rotate the API token** that was pasted into the chat session on 2026-08-25. It is in
   that transcript in plaintext.

6. **Then start Phase 2's 48-hour clock.** It only counts once `runs` shows zero errors
   across every kind, including precompute.

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

## Priority 0 — status after the PR #6 merge (2026-08-25 21:44)

### 1. Phase 4 deployed — RESOLVED

`v0.4` merged to `main` as `5000c36` (PR #6) and deployed at 21:44:18 UTC as version
`785c244d`. Verified live on `bazaar.liamthemo.com`:

- `/api/status` 200 — reports `lastIngestAt`, `dataAgeSeconds`, row counts, per-cron
  `runs` state.
- `/api/recipes` 200 — 42 recipes.
- `/api/scan` 200 — 42 rows.

Local gates on merged `main`: `npm test` 210 passing across 20 files, `npm run typecheck`
clean.

Side benefit: the 21:44 `wrangler deploy` also cleared the config drift noted earlier —
the live script had carried a stray `bazaar_archive` R2 binding that was not in
`wrangler.jsonc`, and its bindings now match the repo exactly. That is what re-deploying
from a clean checkout is supposed to do.

**Still unverified:** `precompute` has not run under the new code yet — the hourly cron
fires at :07, so the first real test is 22:07 UTC. Until then `runs` still shows the old
stub's `error: "not implemented"` as the most recent precompute row.

### 2. Double cron firing — appears to have stopped, keep watching

Last doubled tick was **21:35** (runs at 21:35:05 and 21:35:59). The 21:40 and 21:45
ticks are single. Note the timing: it stopped ~4 minutes *before* the 21:44 deploy, so
the redeploy is **not** what fixed it — the duplicate schedule registration seems to have
aged out on Cloudflare's side on its own, roughly 3.5 hours after the 18:10 deploy that
introduced it.

That matters for two reasons: it can presumably come back on the next deploy, and it
means the mechanism is still not understood. Check `runs` for a doubled tick after the
next few deploys. Evidence, if it recurs and needs a support ticket — two distinct
scheduled events, one cron, ~55s apart, same script version:

```
log 21:15:06  */5 * * * *  scheduledTime 21:15:04  ver fbb5f89f  req 393805d979
log 21:16:03  */5 * * * *  scheduledTime 21:15:59  ver fbb5f89f  req 62d166b655
```

Ruled out along the way: the other Worker on the account (`liamthemo` — personal site, no
D1 binding, no schedules), duplicate schedule registration (the API lists exactly three),
a gradual-deployment version split (one version at 100%), double-recording in our own
code, and the two Cloudflare API tokens (credentials cannot schedule or invoke anything).

**Snapshots written between 2026-08-25 18:10 and 21:40 are doubled** — two rows per tag
per tick, 54s apart. Any growth rate or `samples` figure measured over that window is 2x
inflated. Consider deleting the off-boundary rows.

### 3. Production KV was written by a dev session — FIXED IN CONFIG, plus one manual step

`/api/scan` on default params was serving a KV payload stamped 18:36:18 in which all 42
recipes read `no-base-data`. The old deployed code never wrote KV, and no precompute run
has ever succeeded — the author was a local `wrangler dev` session, because
`wrangler.jsonc` set `"remote": true` on the `CACHE` binding, which makes dev read **and
write** the production namespace.

`"remote": true` is now removed (ADR-020). Local dev gets an empty namespace and
`/api/scan` takes its live-D1 fallback, which is the path worth exercising locally anyway.

The bad key is still in production KV. The 22:07 precompute under the new code should
overwrite it — verify that it did rather than assuming.

The engine was never at fault: forcing the live D1 path returns 40 scored crafts and 2
`zero-price`, not 42 failures.

### 4. Scan query parameters — FIXED IN CODE, not yet deployed

`parseScanQueryParams` now returns a typed result, and `/api/scan` and `/api/craft/:tag`
answer 400 naming the offending parameter and its range. `?tax=1.25` (percent instead of
the fraction 0.0125) used to return 200 with every craft showing a confident, wrong loss;
it now returns 400 with a message that names the correct form. Ranges cover `tax`,
`capture`, `tick`, `sleepStart`, `sleepEnd`, `window`, `capital`. Six tests added. See
ADR-019 for why reject rather than clamp or silently default.

### 5. Phase 4's Done-when is still open

"<50ms warm" has not been measured, because there has never been a warm KV path to
measure — the key is stale junk and precompute has never succeeded. Measure it after
22:07, server-side (observability `wallTimeMs` on the fetch event), not with `curl`
wall-clock from a dev container.

### 6. Ingest idempotency — FIXED IN CODE, not yet deployed

`src/worker/ingest.ts` now stamps every row with the tick boundary
(`floor(now / 300) * 300`) instead of the wall clock: `products.ts`, `snapshots.ts`, the
`hourly` row's `last_tick_ts`, and the R2 archive key. `runs.started_at` stays wall-clock
so an operator can still see when a tick really executed.

One correction to what this note said earlier: `buildHourlyIncrementalUpsert` does **not**
need separate work. It already carries a `WHERE hourly.last_tick_ts < excluded.last_tick_ts`
guard; wall-clock stamps were defeating it, because the duplicate delivery arrived with a
*later* timestamp and so was never the "same tick" the guard was written for. Quantizing
makes that guard fire correctly, and makes duplicate `snapshots` rows collide on
`(tag, ts)`. One fix, both paths. See ADR-018.

Regression test: `src/worker/ingest.test.ts` asserts the incident's real timestamp pair
(21:15:04 and 21:15:59) maps to one boundary.

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
