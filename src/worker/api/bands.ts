import {
  DEFAULT_HIGH_PERCENTILE,
  DEFAULT_LOW_PERCENTILE,
  DEFAULT_WINDOW_DAYS,
  computeBand,
  normalizeHourlyRow,
  normalizeMany,
  type WeeklyBand,
} from "@core/index.js";
import type { Env } from "../index.js";
import {
  BAND_SCAN_KV_KEY,
  DEFAULT_BAND_SCAN_PARAMS,
  runBandScan,
} from "../bandScan.js";
import { selectHourlyBarsForTag } from "../db/history.js";
import { errorResponse, json } from "./index.js";

/**
 * `GET /api/bands/:tag` — where to rest a buy order and a sell offer, with the hit-rate
 * that says whether either would ever fill.
 *
 * Reads `hourly` directly. No schema change was needed for any of this: `hourly` already
 * carries `bid_min/bid_avg/bid_max` and `ask_min/ask_avg/ask_max`, which is exactly the
 * pair of statistics the band and the touch test need (see packages/core/src/bands.ts).
 */

export interface BandQueryParams {
  readonly windowDays: number;
  readonly lowPercentile: number;
  readonly highPercentile: number;
}

export const BAND_PARAM_RANGES = {
  days: { min: 1, max: 30, hint: "a trailing window in days, 1-30" },
  pLow: { min: 0, max: 1, hint: "a percentile as a fraction, so p10 is 0.1" },
  pHigh: { min: 0, max: 1, hint: "a percentile as a fraction, so p90 is 0.9" },
} as const;

export type BandParamResult =
  | { readonly ok: true; readonly value: BandQueryParams }
  | { readonly ok: false; readonly message: string };

/**
 * Rejected, never clamped or silently defaulted — ADR-019. `?pLow=10` meaning "the 10th
 * percentile" is the obvious mistake here, and clamping it to 1.0 would return a
 * confident band built from the maximum instead of the tenth percentile.
 */
export function parseBandParams(url: URL): BandParamResult {
  const read = (
    name: keyof typeof BAND_PARAM_RANGES,
    fallback: number,
  ): number | { message: string } => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    const range = BAND_PARAM_RANGES[name];
    if (!Number.isFinite(value)) {
      return { message: `'${name}' must be a number (${range.hint}); got '${raw}'` };
    }
    if (value < range.min || value > range.max) {
      return {
        message: `'${name}' must be between ${range.min} and ${range.max} — ${range.hint}; got ${value}`,
      };
    }
    return value;
  };

  const windowDays = read("days", DEFAULT_WINDOW_DAYS);
  if (typeof windowDays !== "number") return { ok: false, message: windowDays.message };
  const lowPercentile = read("pLow", DEFAULT_LOW_PERCENTILE);
  if (typeof lowPercentile !== "number") return { ok: false, message: lowPercentile.message };
  const highPercentile = read("pHigh", DEFAULT_HIGH_PERCENTILE);
  if (typeof highPercentile !== "number") return { ok: false, message: highPercentile.message };

  if (lowPercentile >= highPercentile) {
    return {
      ok: false,
      message: `'pLow' (${lowPercentile}) must be below 'pHigh' (${highPercentile}) — the buy band sits under the sell band`,
    };
  }

  return { ok: true, value: { windowDays, lowPercentile, highPercentile } };
}

export interface BandPayload extends WeeklyBand {
  readonly tag: string;
}

export async function handleBands(tag: string, url: URL, env: Env): Promise<Response> {
  if (tag === "") return errorResponse("missing tag", 400);

  const params = parseBandParams(url);
  if (!params.ok) return errorResponse(params.message, 400);

  const now = Math.floor(Date.now() / 1000);
  const sinceTs = now - params.value.windowDays * 86_400;
  const rows = await selectHourlyBarsForTag(env.DB, tag, sinceTs);
  if (rows.length === 0) return errorResponse(`no data for tag '${tag}'`, 404);

  const { ok: bars } = normalizeMany(rows, normalizeHourlyRow);
  const result = computeBand({
    bars,
    asOf: now,
    windowDays: params.value.windowDays,
    lowPercentile: params.value.lowPercentile,
    highPercentile: params.value.highPercentile,
  });
  if (!result.ok) return errorResponse(`cannot compute a band for '${tag}': ${result.error}`, 422);

  // Freshness is the newest bar we actually used, never Date.now() — the same rule the
  // craft routes follow. A band computed from a stale series must not claim to be fresh.
  let latestTs = sinceTs;
  for (const b of bars) if (b.ts > latestTs) latestTs = b.ts;

  const payload: BandPayload = { tag, ...result.value };
  return json(
    payload,
    // The band moves only when a new hour lands, so it is stale once the next hourly
    // rollup should have run (:07 past the hour).
    { generatedAt: latestTs, staleAfter: latestTs + 3600, source: "d1" },
    200,
    "public, max-age=300",
  );
}

/**
 * `GET /api/bands` — every Tier A tag ranked best to worst by profit/day.
 *
 * Default parameters are a single KV read of the cron's precomputed payload. Anything
 * else recomputes from D1, which is affordable because runBandScan pages in bulk rather
 * than querying per tag — but it is still an order of magnitude dearer than the KV hit,
 * so the default path is the one that matters.
 */
export async function handleBandScan(url: URL, env: Env): Promise<Response> {
  const params = parseBandParams(url);
  if (!params.ok) return errorResponse(params.message, 400);

  const isDefault =
    params.value.windowDays === DEFAULT_WINDOW_DAYS &&
    params.value.lowPercentile === DEFAULT_LOW_PERCENTILE &&
    params.value.highPercentile === DEFAULT_HIGH_PERCENTILE;

  if (isDefault) {
    const raw = await env.CACHE.get(BAND_SCAN_KV_KEY);
    if (raw !== null) {
      // Served verbatim, meta included. Regenerating meta here would erase the evidence
      // that the cron has stopped — a client must be able to see staleAfter in the past.
      return new Response(raw, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await runBandScan(
    env.DB,
    { ...DEFAULT_BAND_SCAN_PARAMS, ...params.value },
    now,
  );
  return json(
    result.rows,
    { generatedAt: result.dataTo, staleAfter: result.dataTo + 3600, source: "d1" },
    200,
    "public, max-age=300",
  );
}
