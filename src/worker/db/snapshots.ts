import { chunkByParamCount } from "./chunk.js";

/** Tier A only — CLAUDE.md section 2. */
export interface SnapshotRow {
  readonly tag: string;
  readonly ts: number;
  readonly ask: number;
  readonly bid: number;
  readonly askDepth: number;
  readonly bidDepth: number;
  readonly ibWeek: number;
  readonly isWeek: number;
  readonly askDepth1pct: number;
  readonly bidDepth1pct: number;
  readonly askDepth5pct: number;
  readonly bidDepth5pct: number;
  readonly askMaxWall: number;
  readonly bidMaxWall: number;
  readonly askOrderCount: number;
  readonly bidOrderCount: number;
}

const PARAMS_PER_ROW = 16;

/**
 * Plain upsert on (tag, ts) — idempotent by construction. A retry at the same
 * timestamp overwrites with identical values, never duplicates (ROADMAP Phase 2).
 */
export function buildSnapshotsUpsert(
  db: Pick<D1Database, "prepare">,
  rows: readonly SnapshotRow[],
): D1PreparedStatement[] {
  return chunkByParamCount(rows, PARAMS_PER_ROW).map((chunk) => {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO snapshots (
        tag, ts, ask, bid, ask_depth, bid_depth, ib_week, is_week,
        ask_depth_1pct, bid_depth_1pct, ask_depth_5pct, bid_depth_5pct,
        ask_max_wall, bid_max_wall, ask_order_count, bid_order_count
      )
      VALUES ${placeholders}
      ON CONFLICT(tag, ts) DO UPDATE SET
        ask             = excluded.ask,
        bid             = excluded.bid,
        ask_depth       = excluded.ask_depth,
        bid_depth       = excluded.bid_depth,
        ib_week         = excluded.ib_week,
        is_week         = excluded.is_week,
        ask_depth_1pct  = excluded.ask_depth_1pct,
        bid_depth_1pct  = excluded.bid_depth_1pct,
        ask_depth_5pct  = excluded.ask_depth_5pct,
        bid_depth_5pct  = excluded.bid_depth_5pct,
        ask_max_wall    = excluded.ask_max_wall,
        bid_max_wall    = excluded.bid_max_wall,
        ask_order_count = excluded.ask_order_count,
        bid_order_count = excluded.bid_order_count
    `;
    const args = chunk.flatMap((r) => [
      r.tag,
      r.ts,
      r.ask,
      r.bid,
      r.askDepth,
      r.bidDepth,
      r.ibWeek,
      r.isWeek,
      r.askDepth1pct,
      r.bidDepth1pct,
      r.askDepth5pct,
      r.bidDepth5pct,
      r.askMaxWall,
      r.bidMaxWall,
      r.askOrderCount,
      r.bidOrderCount,
    ]);
    return db.prepare(sql).bind(...args);
  });
}
