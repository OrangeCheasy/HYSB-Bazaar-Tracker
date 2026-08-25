# TODO — resume here

Written 2026-08-25. Delete this file once everything below is done; it's a session
handoff note, not a permanent doc (CLAUDE.md/ROADMAP.md/DECISIONS.md are the permanent
ones).

## Where things actually stand

Phase 2 (data layer + ingestion) is fully implemented, tested, and **already merged to
`main`** (PR #4 "v0.0.5" and PR #5 "v0.2"). Locally, against `wrangler dev --local` with
real Hypixel data, it's been verified end-to-end: ingest writes products/snapshots/hourly
correctly, the Tier B running-average upsert is idempotent, hourly/daily rollup work,
pruning works, R2 archive writes real per-tick objects, and a deliberately broken fetch
URL correctly gets recorded as a failure in `runs` instead of crashing.

**What's missing is entirely on the Cloudflare side**, and it was blocked on
authentication (this sandbox never got a valid `CLOUDFLARE_API_TOKEN` / `wrangler login`)
when this session ended. Nobody has run these against production:

- `npx wrangler r2 bucket create bazaar-archive` — the bucket the `ARCHIVE` binding in
  `wrangler.jsonc` points to. **It does not exist yet.**
- `npm run db:migrate` (applies `migrations/0002` and `0003` to the **remote** D1 —
  `db:migrate:local` doesn't touch production, they're entirely separate databases).

## Priority 0 — check whether production is actively broken right now

Your README states a push to `main` triggers an automatic Workers Builds deploy, and
that Workers Builds does **not** run D1 migrations. If that push already deployed (likely
— PR #5 merged hours before this note), the live Worker's `scheduled` handler has been
trying to run every 5 minutes against a database missing the new columns and an R2
binding pointing at a bucket that doesn't exist. That could mean:
- The Worker failed to even deploy (an `r2_buckets` binding to a nonexistent bucket may
  hard-fail the build) — check the Cloudflare dashboard's Workers Builds tab, or
- It deployed fine but every ingest tick has been erroring — check `runs` on the
  **remote** DB: `npx wrangler d1 execute bazaar --remote --command "SELECT * FROM runs
  ORDER BY id DESC LIMIT 10"`

Do this check FIRST, before anything else below — it tells you whether you're fixing an
active outage or just finishing setup before first deploy.

## Steps, in order

1. **Auth**: `wrangler login` (or set `CLOUDFLARE_API_TOKEN` in your shell env).
2. **Create the R2 bucket**: `npx wrangler r2 bucket create bazaar-archive`
3. **Migrate remote D1**: `npm run db:migrate` (this is the `--remote` variant per
   `package.json` — double-check it targets `--remote` and not local before running)
4. **Confirm**: `npx wrangler d1 execute bazaar --remote --command "SELECT name FROM
   sqlite_master WHERE type='table'"` and check `recipes` has 42 rows:
   `npx wrangler d1 execute bazaar --remote --command "SELECT COUNT(*) FROM recipes"`
5. **If the Worker didn't already deploy successfully in step 0**, trigger a redeploy
   now that the bucket/DB exist (push an empty commit, or use the Cloudflare dashboard's
   "retry deployment").
6. **Watch it run unattended for 48 hours** — this is Phase 2's actual Done-when bar
   from `docs/ROADMAP.md`. Check `runs` shows zero errors, pruning has deleted something
   once `snapshots` crosses 7 days old, and R2 has real objects accumulating under
   `archive/`.

## Local dev environment, if this is a fresh clone/machine

`.wrangler/` (local D1 + R2 state) and `node_modules/` are both gitignored — a fresh
checkout starts with neither. Before `npm run dev` will work locally:

```bash
npm install
npm run db:migrate:local   # applies 0001, 0002, 0003 to a fresh local D1
npm run build              # dist/client must exist for wrangler dev's assets binding
```

## Smaller things noticed along the way, not urgent

- CLAUDE.md §2's Tier A growth figure (~350 MB/year) was measured against a 150-tag
  (recipe-only) definition during Phase 0.5, but the code now implements the broader
  "recipe tags + top 500 by volume" definition (~650 tags) per your explicit choice
  during planning. Worth a fresh measurement once real data exists, to replace that
  estimate the same way Phase 0.5 replaced the original ones.
- The Python reference tool (`bzapi.py`, `bzcraft.py`, `model.py`, `config.json`) still
  lives at repo root instead of `reference/bzcraft/` as `PROMPTS.MD`'s Phase 1 prompt
  originally specified. Harmless — `docs/DECISIONS.md`'s ADRs already cite the root
  paths — just a structural tidiness item if you ever care.
- `docs/ROADMAP.md`'s Phase 2 section still literally says "a tag is Tier A if
  referenced by a recipe," which is narrower than what got built (recipe tags + top 500
  by volume, matching CLAUDE.md §2). Worth a one-line edit to ROADMAP so the two docs
  agree.
