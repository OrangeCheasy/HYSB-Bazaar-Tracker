-- 0007_converge_indexes.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- Brings every database to the same index set. Until now the repo and production
-- disagreed, and nothing in the migration history explained why.
--
-- Discovered 2026-08-26 while verifying that the chain replays on a clean database
-- (ADR-024). A fresh replay produced a schema byte-identical to production across all six
-- tables, but a DIFFERENT set of indexes:
--
--   fresh replay:  idx_products_tier, idx_snapshots_ts, idx_hourly_hour_ts,
--                  idx_runs_started
--   production:    idx_products_tier, idx_snapshots_ts, idx_hourly_hour_ts,
--                  idx_runs_kind_started, idx_daily_day_ts
--
-- `idx_runs_kind_started` and `idx_daily_day_ts` appear in NO migration. They were
-- created directly against production at some point, which is the same class of mistake
-- as editing an applied migration: the repo stopped describing the database. Production
-- also lacks `idx_runs_started`, which 0001 creates, so the drift runs both ways.
--
-- Rather than pick a winner by seniority, each index below is justified by a query that
-- exists in the code today:
--
--   idx_daily_day_ts       -- rollup.ts's new 30-day daily prune does
--                          -- `DELETE FROM daily WHERE day_ts < cutoff` across ALL tags.
--                          -- daily's PRIMARY KEY (tag, day_ts) cannot serve that; it
--                          -- leads with tag. Without this index the prune added in
--                          -- ADR-021 is a full scan every night.
--                          -- (history.ts's `WHERE tag = ? AND day_ts BETWEEN` IS served
--                          --  by the primary key, so this index is for the prune alone.)
--
--   idx_runs_kind_started  -- db/runs.ts filters by kind in both of its queries:
--                          -- `SELECT kind, MAX(id) FROM runs GROUP BY kind` and
--                          -- `WHERE kind = ?1 AND error IS NULL ORDER BY id DESC`.
--
-- And one dropped:
--
--   idx_runs_started       -- ON runs(started_at DESC). No query in src/ orders by
--                          -- started_at without also filtering by kind, so it earns
--                          -- nothing that idx_runs_kind_started does not already cover.
--                          -- Production has never had it. Dropping it here converges
--                          -- fresh databases onto production rather than the reverse.
--
-- All three statements are no-ops against production, which already matches this state.
-- They do the real work on any freshly-created database.

CREATE INDEX IF NOT EXISTS idx_daily_day_ts      ON daily (day_ts);
CREATE INDEX IF NOT EXISTS idx_runs_kind_started ON runs (kind, started_at DESC);

DROP INDEX IF EXISTS idx_runs_started;
