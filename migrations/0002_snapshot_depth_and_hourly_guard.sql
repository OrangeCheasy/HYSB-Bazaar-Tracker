-- 0002_snapshot_depth_and_hourly_guard.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- Two fixes to 0001, both found before Phase 2 ingest.ts was written against the schema:
--
-- 1. `snapshots.depth_1pct` / `depth_5pct` / `max_wall` had no side label, unlike
--    `ask_depth`/`bid_depth` two columns up. A depth-within-1% number with no side is
--    ambiguous — a sell wall depresses price, a buy wall props it up, and CLAUDE.md
--    section 3 says these columns exist to catch exactly that kind of manipulation.
--    Split into ask_/bid_ pairs. Also add order_count (named in CLAUDE.md section 3 and
--    ROADMAP's Phase 2 text, but missing from 0001 entirely) split the same way: one big
--    order and fifty small ones summing to the same depth are different signals.
--
-- 2. `hourly` gains `last_tick_ts`, an idempotency guard for Tier B's direct-write path.
--    Tier B has no `snapshots` row to upsert against by (tag, ts) — ingest updates the
--    current hour's `hourly` row in place via a running average. Without a guard, a
--    retried ingest tick at the same timestamp would apply twice, corrupting `samples`
--    and silently lying about how many observations actually built that hourly row
--    (CLAUDE.md section 3b: `hourly.samples` must be honest, this is load-bearing).
--    Defaults to 0, not NULL — SQLite's `NULL < x` is falsy, which would permanently
--    block the first real update on a row seeded with a null guard.

ALTER TABLE snapshots DROP COLUMN depth_1pct;
ALTER TABLE snapshots DROP COLUMN depth_5pct;
ALTER TABLE snapshots DROP COLUMN max_wall;

ALTER TABLE snapshots ADD COLUMN ask_depth_1pct   REAL;
ALTER TABLE snapshots ADD COLUMN bid_depth_1pct   REAL;
ALTER TABLE snapshots ADD COLUMN ask_depth_5pct   REAL;
ALTER TABLE snapshots ADD COLUMN bid_depth_5pct   REAL;
ALTER TABLE snapshots ADD COLUMN ask_max_wall     REAL;
ALTER TABLE snapshots ADD COLUMN bid_max_wall     REAL;
ALTER TABLE snapshots ADD COLUMN ask_order_count  REAL;
ALTER TABLE snapshots ADD COLUMN bid_order_count  REAL;

ALTER TABLE hourly ADD COLUMN last_tick_ts INTEGER NOT NULL DEFAULT 0;
