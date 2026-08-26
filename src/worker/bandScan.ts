import {
  bandEconomics,
  computeBand,
  normalizeHourlyRow,
  DEFAULT_HIGH_PERCENTILE,
  DEFAULT_LOW_PERCENTILE,
  DEFAULT_WINDOW_DAYS,
  type BandScanRow,
  type Bar,
  type BandMarket,
  type RawHourlyRow,
} from "@core/index.js";
import type { Env } from "./index.js";

/**
 * The ranked band scan: every Tier A tag, best to worst by profit/day.
 *
 * The interesting problem here is budget, and it is the same wall the anvil scan hit. A
 * band needs a tag's whole hourly series, and one query per tag is 793 queries for Tier A
 * — against a hard D1 cap of 1,000 per invocation, with nothing left for the rest of the
 * cron. Fetching every row in one query instead is ~133k rows (793 tags x 168 hours),
 * which is one query but tens of megabytes of objects against a 128MB isolate.
 *
 * Neither. Rows are pulled in bulk pages ORDERED BY tag, and a tag's band is finalized the
 * moment the tag changes — so the query count is `total rows / page size` (~14 pages, not
 * 793 queries) and resident memory is one tag's 168 bars (~40KB, not 133k objects). The
 * ordering is what makes the streaming safe: rows for a tag can never reappear after a
 * later tag has been seen.
 */

/** Rows per page. 5,000 x ~14 columns stays well inside a D1 response while keeping the
 *  page count in the teens. */
const PAGE_SIZE = 5000;

/** Hard stop so a runaway cursor cannot loop forever. At PAGE_SIZE this covers ~500k
 *  rows, comfortably above a full Tier A window. */
const MAX_PAGES = 100;

export interface BandScanParams {
  readonly windowDays: number;
  readonly lowPercentile: number;
  readonly highPercentile: number;
  readonly market: BandMarket;
  /** Rows per page. Injectable so pagination can be exercised with small pages in tests;
   *  production never sets it. */
  readonly pageSize?: number;
}

export const DEFAULT_BAND_SCAN_PARAMS: BandScanParams = {
  windowDays: DEFAULT_WINDOW_DAYS,
  lowPercentile: DEFAULT_LOW_PERCENTILE,
  highPercentile: DEFAULT_HIGH_PERCENTILE,
  market: { sellTaxRate: 0.0125, captureFraction: 0.2 },
};

/** Shape declared in packages/core/src/wire.ts: `/api/bands` serves these rows and the
 *  band table renders them, so the client imports the same type. */
export type { BandScanRow };

export interface BandScanResult {
  readonly rows: readonly BandScanRow[];
  /** Tags that had rows but could not produce a band, by reason. Reported rather than
   *  dropped silently — "47 tags lack 24 hours of history" is operationally useful. */
  readonly skipped: Readonly<Record<string, number>>;
  /** Oldest "freshest bar" across included tags — the payload is only as fresh as its
   *  stalest ingredient. */
  readonly dataTo: number;
}

interface TaggedHourlyRow extends RawHourlyRow {
  readonly tag: string;
}

/**
 * Finalize one tag once all of its rows have been seen.
 *
 * Volume comes from the NEWEST bar rather than an average: `ibWeek`/`isWeek` are already
 * trailing-seven-day counters, so averaging them over a week would smear a week of history
 * across a figure that is itself a week of history (the same reasoning as ADR-013).
 */
function finalize(
  tag: string,
  bars: readonly Bar[],
  params: BandScanParams,
  now: number,
): { row?: BandScanRow; skip?: string; latestTs?: number } {
  const result = computeBand({
    bars,
    asOf: now,
    windowDays: params.windowDays,
    lowPercentile: params.lowPercentile,
    highPercentile: params.highPercentile,
  });
  if (!result.ok) return { skip: result.error };

  let newest = bars[0];
  for (const b of bars) if (!newest || b.ts > newest.ts) newest = b;
  if (!newest) return { skip: "no-bars" };

  const economics = bandEconomics(
    result.value,
    { ibWeek: newest.ibWeek, isWeek: newest.isWeek },
    params.market,
  );
  return { row: { tag, band: result.value, economics }, latestTs: newest.ts };
}

export async function runBandScan(
  db: Pick<D1Database, "prepare">,
  params: BandScanParams,
  now: number,
): Promise<BandScanResult> {
  const sinceTs = now - params.windowDays * 86_400;
  const pageSize = params.pageSize ?? PAGE_SIZE;

  const rows: BandScanRow[] = [];
  const skipped: Record<string, number> = {};
  let dataTo = now;

  let cursorTag = "";
  let cursorTs = 0;
  let currentTag: string | null = null;
  let currentBars: Bar[] = [];
  /** Raw rows seen for the current tag, valid or not — so a tag whose every row fails
   *  normalization is reported rather than vanishing. */
  let currentRawCount = 0;

  const flush = (): void => {
    if (currentTag === null) return;
    if (currentBars.length === 0) {
      // Rows existed but none survived normalization —  asserts
      // rather than fixes (ADR-006), so a crossed hourly row means WE wrote bad data.
      // Counting it keeps the promise made by BandScanResult.skipped; returning early
      // here would delete the tag from the scan with no trace of why.
      if (currentRawCount > 0) skipped["unnormalizable"] = (skipped["unnormalizable"] ?? 0) + 1;
      currentRawCount = 0;
      return;
    }
    const { row, skip, latestTs } = finalize(currentTag, currentBars, params, now);
    if (row) {
      rows.push(row);
      if (latestTs !== undefined && latestTs < dataTo) dataTo = latestTs;
    } else if (skip) {
      skipped[skip] = (skipped[skip] ?? 0) + 1;
    }
    currentBars = [];
    currentRawCount = 0;
  };

  for (let page = 0; page < MAX_PAGES; page++) {
    // Keyset pagination on (tag, hour_ts) — stable under concurrent writes in a way
    // OFFSET is not, and it is the ordering that lets a tag be finalized on sight of the
    // next one. Restricted to Tier A: banding all 2,136 products would double the work
    // for tags whose five-minute history we deliberately do not keep (CLAUDE.md §2).
    const { results } = await db
      .prepare(
        `SELECT h.tag, h.hour_ts, h.ask_avg, h.ask_min, h.ask_max,
                h.bid_avg, h.bid_min, h.bid_max, h.ask_depth, h.bid_depth,
                h.ib_week, h.is_week, h.samples, h.source
           FROM hourly h
           JOIN products p ON p.tag = h.tag AND p.tier = 'A'
          WHERE h.hour_ts >= ?1
            AND (h.tag > ?2 OR (h.tag = ?2 AND h.hour_ts > ?3))
          ORDER BY h.tag, h.hour_ts
          LIMIT ?4`,
      )
      .bind(sinceTs, cursorTag, cursorTs, pageSize)
      .all<TaggedHourlyRow>();

    if (results.length === 0) break;

    for (const raw of results) {
      if (raw.tag !== currentTag) {
        flush();
        currentTag = raw.tag;
      }
      currentRawCount++;
      const bar = normalizeHourlyRow(raw);
      // A crossed row means ingest wrote bad data; drop the hour, not the tag.
      if (bar.ok) currentBars.push(bar.value);
    }

    const last = results[results.length - 1];
    if (!last) break;
    cursorTag = last.tag;
    cursorTs = last.hour_ts;
    if (results.length < pageSize) break;
  }
  flush();

  rows.sort((a, b) => b.economics.profitPerDay - a.economics.profitPerDay);
  return { rows, skipped, dataTo: rows.length > 0 ? dataTo : now };
}

/** KV key for the precomputed default band scan. Versioned like the craft scan, so a
 *  payload shape change ships without a migration — an old key just falls out of use. */
export const BAND_SCAN_KV_KEY = "bands:default:v1";

export interface BandScanPayload {
  readonly data: readonly BandScanRow[];
  readonly meta: {
    readonly generatedAt: number;
    readonly staleAfter: number;
    readonly source: "kv";
  };
}

export async function precomputeBandScan(env: Env, now: number): Promise<number> {
  const result = await runBandScan(env.DB, DEFAULT_BAND_SCAN_PARAMS, now);
  const payload: BandScanPayload = {
    data: result.rows,
    meta: {
      generatedAt: result.dataTo,
      // Bands move only when a new hour lands, so this is stale once the next hourly
      // rollup should have run.
      staleAfter: result.dataTo + 3600,
      source: "kv",
    },
  };
  await env.CACHE.put(BAND_SCAN_KV_KEY, JSON.stringify(payload));
  return result.rows.length;
}
