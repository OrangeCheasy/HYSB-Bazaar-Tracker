-- 0001_initial.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- All timestamps are UTC epoch SECONDS (integer). No local times, ever.
-- Prices are REAL. Bazaar prices are genuinely fractional and get multiplied by 160,
-- so integer-cents rounding introduces real drift.

CREATE TABLE products (
  tag           TEXT PRIMARY KEY,
  is_enchanted  INTEGER NOT NULL DEFAULT 0,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE recipes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  base_tag     TEXT NOT NULL,
  ench_tag     TEXT NOT NULL,
  ratio        INTEGER NOT NULL,
  -- Tag existence can be validated automatically. Ratios CANNOT — name matching
  -- cannot see a crafting grid. Unverified recipes must be marked in the UI.
  verified     INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  UNIQUE (base_tag, ench_tag)
);

-- 5-minute resolution. Pruned to 7 days. ~430k rows/day at full product coverage.
CREATE TABLE snapshots (
  tag        TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  ask        REAL NOT NULL,   -- higher price: lowest sell offer
  bid        REAL NOT NULL,   -- lower price: highest buy order
  ask_depth  REAL NOT NULL,   -- units resting in sell offers
  bid_depth  REAL NOT NULL,   -- units resting in buy orders (queue ahead of your order)
  ib_week    REAL NOT NULL,   -- units instant-bought, trailing week
  is_week    REAL NOT NULL,   -- units instant-sold, trailing week (fills YOUR buy orders)
  PRIMARY KEY (tag, ts)
) WITHOUT ROWID;

CREATE INDEX idx_snapshots_ts ON snapshots (ts);

-- Hourly rollup. Retained indefinitely. This is what the site actually reads.
CREATE TABLE hourly (
  tag       TEXT NOT NULL,
  hour_ts   INTEGER NOT NULL,  -- epoch seconds, truncated to the hour
  ask_avg   REAL NOT NULL,
  ask_min   REAL NOT NULL,
  ask_max   REAL NOT NULL,
  bid_avg   REAL NOT NULL,
  bid_min   REAL NOT NULL,
  bid_max   REAL NOT NULL,
  ask_depth REAL NOT NULL,
  bid_depth REAL NOT NULL,
  ib_week   REAL NOT NULL,
  is_week   REAL NOT NULL,
  samples   INTEGER NOT NULL,
  source    TEXT NOT NULL DEFAULT 'hypixel',  -- 'hypixel' | 'coflnet' (backfill)
  PRIMARY KEY (tag, hour_ts)
) WITHOUT ROWID;

CREATE INDEX idx_hourly_hour_ts ON hourly (hour_ts);

-- Daily rollup. Serves anything older than 90 days.
CREATE TABLE daily (
  tag      TEXT NOT NULL,
  day_ts   INTEGER NOT NULL,
  ask_avg  REAL NOT NULL,
  ask_min  REAL NOT NULL,
  ask_max  REAL NOT NULL,
  bid_avg  REAL NOT NULL,
  bid_min  REAL NOT NULL,
  bid_max  REAL NOT NULL,
  ib_week  REAL NOT NULL,
  is_week  REAL NOT NULL,
  samples  INTEGER NOT NULL,
  PRIMARY KEY (tag, day_ts)
) WITHOUT ROWID;

-- You cannot debug a cron you cannot see.
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,     -- 'ingest' | 'rollup' | 'prune' | 'precompute'
  started_at    INTEGER NOT NULL,
  duration_ms   INTEGER,
  products_seen INTEGER,
  rows_written  INTEGER,
  error         TEXT
);

CREATE INDEX idx_runs_started ON runs (started_at DESC);