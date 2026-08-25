import { chunkByParamCount } from "./chunk.js";

/** `daily` has no depth or source columns (unlike snapshots/hourly) — see 0001_initial.sql.
 *  Older than 90 days is long enough that per-side depth and provenance stop mattering. */
export interface DailyRow {
  readonly tag: string;
  readonly dayTs: number;
  readonly askAvg: number;
  readonly askMin: number;
  readonly askMax: number;
  readonly bidAvg: number;
  readonly bidMin: number;
  readonly bidMax: number;
  readonly ibWeek: number;
  readonly isWeek: number;
  readonly samples: number;
}

const PARAMS_PER_ROW = 11;

/** Wholesale replace, same reasoning as hourly's Tier A path: rollup recomputes the
 *  full day from `hourly` every time, never an average of an average. */
export function buildDailyUpsert(
  db: Pick<D1Database, "prepare">,
  rows: readonly DailyRow[],
): D1PreparedStatement[] {
  return chunkByParamCount(rows, PARAMS_PER_ROW).map((chunk) => {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO daily (
        tag, day_ts, ask_avg, ask_min, ask_max, bid_avg, bid_min, bid_max,
        ib_week, is_week, samples
      )
      VALUES ${placeholders}
      ON CONFLICT(tag, day_ts) DO UPDATE SET
        ask_avg = excluded.ask_avg,
        ask_min = excluded.ask_min,
        ask_max = excluded.ask_max,
        bid_avg = excluded.bid_avg,
        bid_min = excluded.bid_min,
        bid_max = excluded.bid_max,
        ib_week = excluded.ib_week,
        is_week = excluded.is_week,
        samples = excluded.samples
    `;
    const args = chunk.flatMap((r) => [
      r.tag,
      r.dayTs,
      r.askAvg,
      r.askMin,
      r.askMax,
      r.bidAvg,
      r.bidMin,
      r.bidMax,
      r.ibWeek,
      r.isWeek,
      r.samples,
    ]);
    return db.prepare(sql).bind(...args);
  });
}
