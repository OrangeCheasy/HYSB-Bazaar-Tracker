-- 0004_fix_remote_0001_drift.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- Why this migration exists instead of 0002 having just worked:
-- `migrations/0001_initial.sql` was edited in place after it had already been applied
-- to the remote D1 database (commit a88c1d2 applied remotely on 2026-08-24 08:00:42,
-- then commit 5ab7298 added `depth_1pct`/`depth_5pct`/`max_wall` to the same file's
-- `snapshots` CREATE TABLE). That's exactly the mistake CLAUDE.md section 5 warns
-- against. Local dev never noticed because `wrangler d1 migrations apply --local`
-- reruns against a fresh SQLite file that always reflects the latest 0001 content.
-- Remote's `d1_migrations` bookkeeping table only ever recorded the pre-edit 0001, so
-- remote's real `snapshots` table never had those three columns at all -- which is why
-- 0002's `ALTER TABLE snapshots DROP COLUMN depth_1pct` failed with
-- "no such column: depth_1pct" (SQLITE_ERROR 7500) when applied for real.
--
-- This migration brings remote directly to the schema 0002 intended, skipping the
-- DROP COLUMN statements entirely since the columns they'd drop were never created on
-- remote in the first place. Confirmed via `PRAGMA table_info(snapshots)` /
-- `PRAGMA table_info(hourly)` against remote before writing this file. Target end
-- state matches what src/worker/db/snapshots.ts and src/worker/db/hourly.ts already
-- query against.
--
-- This is remote-only in effect, not just in origin: on any database that applies the
-- full chain from scratch (a fresh --local dev DB, or a from-scratch remote D1 if this
-- database is ever recreated), 0001+0002 already reach this exact same end state on
-- their own, so this file's ADD COLUMNs would collide with 0002's ("duplicate column
-- name"). On such a database, INSERT this migration's name (and 0005's) directly into
-- d1_migrations as already-applied instead of letting wrangler execute its SQL --
-- exactly as done for 0002 on remote itself. Do not try to make the ALTER statements
-- below conditional -- SQLite's ALTER TABLE has no ADD COLUMN IF NOT EXISTS, and that
-- would make this file harder to review than the bookkeeping-only workaround.

ALTER TABLE snapshots ADD COLUMN ask_depth_1pct   REAL;
ALTER TABLE snapshots ADD COLUMN bid_depth_1pct   REAL;
ALTER TABLE snapshots ADD COLUMN ask_depth_5pct   REAL;
ALTER TABLE snapshots ADD COLUMN bid_depth_5pct   REAL;
ALTER TABLE snapshots ADD COLUMN ask_max_wall     REAL;
ALTER TABLE snapshots ADD COLUMN bid_max_wall     REAL;
ALTER TABLE snapshots ADD COLUMN ask_order_count  REAL;
ALTER TABLE snapshots ADD COLUMN bid_order_count  REAL;

ALTER TABLE hourly ADD COLUMN last_tick_ts INTEGER NOT NULL DEFAULT 0;
