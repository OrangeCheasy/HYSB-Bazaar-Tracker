import type { ChartPoint, RawHourlyRow } from "@core/index.js";

/**
 * Read-side queries for the API layer (Phase 4). Everything here returns rows shaped
 * either as `RawHourlyRow` (for core's `normalizeHourlyRow`/`computeStats`/
 * `computeHourProfile` pipeline) or as a `ChartPoint` (already display-shaped via SQL
 * aliases, for the raw `/history` series where no core math is needed).
 */

/** Hourly bars for one tag, oldest first — feeds computeStats/computeHourProfile via
 *  normalizeHourlyRow. Tier B tags have hourly rows directly; Tier A tags do too, via
 *  the hourly rollup, so this works uniformly regardless of tier. */
export async function selectHourlyBarsForTag(
  db: Pick<D1Database, "prepare">,
  tag: string,
  sinceTs: number,
): Promise<RawHourlyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT hour_ts, ask_avg, ask_min, ask_max, bid_avg, bid_min, bid_max,
              ask_depth, bid_depth, ib_week, is_week, samples, source
       FROM hourly
       WHERE tag = ?1 AND hour_ts >= ?2
       ORDER BY hour_ts ASC`,
    )
    .bind(tag, sinceTs)
    .all<RawHourlyRow>();
  return results;
}

/** Display shape for `/api/item/:tag/history`, declared in packages/core/src/wire.ts —
 *  the SQL aliases below produce it and the chart component consumes it, so it is a wire
 *  type rather than a query-layer one. */
export type { ChartPoint };

/** For `/api/item/:tag/history?range=1d|7d|30d|90d`. No core involvement — this is
 *  display data, not a calculation, so SQL aliases do the whole shape. */
export async function selectHourlyChartSeries(
  db: Pick<D1Database, "prepare">,
  tag: string,
  sinceTs: number,
  untilTs: number,
): Promise<ChartPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT hour_ts as ts, ask_avg as askAvg, ask_min as askMin, ask_max as askMax,
              bid_avg as bidAvg, bid_min as bidMin, bid_max as bidMax, samples
       FROM hourly
       WHERE tag = ?1 AND hour_ts >= ?2 AND hour_ts < ?3
       ORDER BY hour_ts ASC`,
    )
    .bind(tag, sinceTs, untilTs)
    .all<ChartPoint>();
  return results;
}

/** For `/api/item/:tag/history?range=1y|all` — `daily` has no depth/source columns
 *  (0001_initial.sql), so its ChartPoint is the same shape as hourly's minus that. */
export async function selectDailyChartSeries(
  db: Pick<D1Database, "prepare">,
  tag: string,
  sinceTs: number,
  untilTs: number,
): Promise<ChartPoint[]> {
  const { results } = await db
    .prepare(
      `SELECT day_ts as ts, ask_avg as askAvg, ask_min as askMin, ask_max as askMax,
              bid_avg as bidAvg, bid_min as bidMin, bid_max as bidMax, samples
       FROM daily
       WHERE tag = ?1 AND day_ts >= ?2 AND day_ts < ?3
       ORDER BY day_ts ASC`,
    )
    .bind(tag, sinceTs, untilTs)
    .all<ChartPoint>();
  return results;
}
