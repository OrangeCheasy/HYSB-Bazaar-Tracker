import {
  computeHourProfile,
  computeStats,
  normalizeHourlyRow,
  normalizeMany,
  sliceWindow,
  type Stats,
} from "@core/index.js";
import { selectDailyChartSeries, selectHourlyBarsForTag, selectHourlyChartSeries } from "../db/history.js";
import type { Env } from "../index.js";
import { errorResponse, json, type Meta } from "./index.js";

const DAY = 86_400;
/** How far back one fetch reaches — covers every window `/api/item/:tag` reports. */
const STATS_FETCH_DAYS = 30;

function latestTs(rows: readonly { readonly ts: number }[]): number | undefined {
  let latest: number | undefined;
  for (const r of rows) {
    if (latest === undefined || r.ts > latest) latest = r.ts;
  }
  return latest;
}

/**
 * GET /api/item/:tag — Stats across 1d/7d/30d, all sliced from one 30-day fetch
 * (packages/core's sliceWindow) rather than three separate queries.
 */
export async function handleItemStats(tag: string, env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await selectHourlyBarsForTag(env.DB, tag, now - STATS_FETCH_DAYS * DAY);
  const { ok: bars } = normalizeMany(rows, normalizeHourlyRow);
  if (bars.length === 0) return errorResponse(`no data for tag '${tag}'`, 404);

  const windows: Record<"1d" | "7d" | "30d", Stats | null> = { "1d": null, "7d": null, "30d": null };
  for (const [key, days] of [["1d", 1], ["7d", 7], ["30d", 30]] as const) {
    const result = computeStats(sliceWindow(bars, now - days * DAY, now));
    windows[key] = result.ok ? result.value : null;
  }

  // generatedAt is the freshest bar we actually have, not "now" — if the hourly cron
  // has stalled, this must say so rather than claiming freshness it does not have.
  const generatedAt = latestTs(bars) ?? now;
  return json(
    { tag, windows },
    { generatedAt, staleAfter: generatedAt + 3600, source: "d1" },
    200,
    // hourly refreshes at most once an hour; a few minutes of extra staleness on a
    // multi-day stats summary is immaterial, so this trades a little freshness for a
    // meaningful cut in D1 read volume on a page likely to be revisited often.
    "public, max-age=300",
  );
}

const RANGE_TO_SECONDS: Readonly<Record<string, number>> = {
  "1d": 1 * DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
};

function respondHistory(points: readonly { readonly ts: number }[], source: Meta["source"]): Response {
  const now = Math.floor(Date.now() / 1000);
  const generatedAt = latestTs(points) ?? now;
  return json(
    points,
    { generatedAt, staleAfter: generatedAt + 3600, source },
    200,
    // The newest bucket in range is still being written to until its hour/day closes,
    // so this stays close to item-stats' TTL rather than treating the series as
    // immutable — a longer TTL would visibly delay a chart's most recent point.
    "public, max-age=300",
  );
}

/**
 * GET /api/item/:tag/history?range=1d|7d|30d|90d|1y|all — raw series for charting.
 * No core involvement: this is display data (ts + OHLC-ish price fields), not a
 * calculation, so src/worker/db/history.ts shapes it entirely via SQL aliases.
 */
export async function handleItemHistory(tag: string, url: URL, env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const range = url.searchParams.get("range") ?? "7d";

  if (range === "1y" || range === "all") {
    const sinceTs = range === "1y" ? now - 365 * DAY : 0;
    const points = await selectDailyChartSeries(env.DB, tag, sinceTs, now);
    return respondHistory(points, "d1");
  }

  const seconds = RANGE_TO_SECONDS[range];
  if (seconds === undefined) {
    return errorResponse(`unknown range '${range}' (want 1d, 7d, 30d, 90d, 1y, or all)`, 400);
  }
  const points = await selectHourlyChartSeries(env.DB, tag, now - seconds, now);
  return respondHistory(points, "d1");
}

/** GET /api/item/:tag/hours?days= — hour-of-day profile (ROADMAP Phase 3/4). Capped at
 *  90 days: that is all `hourly` retains before rows are pruned to `daily`. */
export async function handleItemHours(tag: string, url: URL, env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const daysRaw = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 90) : 30;

  const rows = await selectHourlyBarsForTag(env.DB, tag, now - days * DAY);
  const { ok: bars } = normalizeMany(rows, normalizeHourlyRow);
  if (bars.length === 0) return errorResponse(`no data for tag '${tag}'`, 404);

  const profile = computeHourProfile(bars);
  if (!profile.ok) return errorResponse("could not compute hour profile", 500);

  const generatedAt = latestTs(bars) ?? now;
  return json(
    profile.value,
    { generatedAt, staleAfter: generatedAt + 3600, source: "d1" },
    200,
    // A profile averages `days` worth of history — one more hour of data barely moves
    // it, so this is the least freshness-sensitive of the item routes and gets the
    // longest TTL to cut read volume accordingly.
    "public, max-age=1800",
  );
}
