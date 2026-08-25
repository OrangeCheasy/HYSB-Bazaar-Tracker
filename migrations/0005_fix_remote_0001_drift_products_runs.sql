-- 0005_fix_remote_0001_drift_products_runs.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- Continuation of the drift fixed in 0004: `migrations/0001_initial.sql` was edited in
-- place after remote had already applied it (see 0004's header comment for the full
-- story). That same edit also added `products.tier` (+ `idx_products_tier`) and
-- `runs.rows_deleted` / `runs.db_size_bytes`, none of which reached remote either.
-- Confirmed via `PRAGMA table_info(products)` / `PRAGMA table_info(runs)` against
-- remote: both are still on the pre-edit shape. src/worker/db/tiers.ts,
-- src/worker/db/products.ts, src/worker/ingest.ts, and src/worker/db/runs.ts all
-- already query against the target shape below.
--
-- Not touched here: remote also still has `idx_runs_kind_started` instead of the
-- current file's `idx_runs_started`, and an extra `idx_daily_day_ts` the current file
-- no longer creates. Both are harmless leftover indexes -- no query fails for their
-- presence or the other's absence -- so this migration only adds what's load-bearing.
--
-- Remote-only in effect, same caveat as 0004: a fresh full-chain database (local dev,
-- or a from-scratch remote D1) already has `tier`/`rows_deleted`/`db_size_bytes` via
-- the current 0001 file directly, so running this file's SQL there would fail with
-- "duplicate column name". Mark it applied via a direct `d1_migrations` INSERT instead
-- of executing it, exactly like 0004.

ALTER TABLE products ADD COLUMN tier TEXT NOT NULL DEFAULT 'B';
CREATE INDEX idx_products_tier ON products (tier);

ALTER TABLE runs ADD COLUMN rows_deleted INTEGER;
ALTER TABLE runs ADD COLUMN db_size_bytes INTEGER;
