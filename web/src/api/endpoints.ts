import type {
  BandPayload,
  BandScanPayload,
  ChartPoint,
  CraftRow,
  HealthPayload,
  HourProfilePayload,
  ItemStatsPayload,
  ProductsPayload,
  RecipesPayload,
  ScanRow,
  StatusPayload,
} from "@core/index.js";
import { queryString, toBandQuery, toScanQuery } from "../settings/toQuery.js";
import type { Settings } from "../settings/schema.js";
import { apiGet, type ApiResult } from "./client.js";

/**
 * One function per route, each returning the payload type declared in
 * `packages/core/src/wire.ts` — the same types the Worker builds its responses from, so a
 * field added on one side is a typecheck failure on the other rather than an
 * `undefined` at runtime.
 *
 * Every function takes an `AbortSignal`: these are all rendered from effects that a route
 * change can outlive.
 */

export type ItemHistoryRange = "1d" | "7d" | "30d" | "90d";

export function fetchHealth(signal?: AbortSignal): Promise<ApiResult<HealthPayload>> {
  return apiGet("/api/health", signal);
}

/** The header's data-age indicator polls this. Public on purpose: data freshness is a
 *  feature, not a secret (CLAUDE.md §3b). */
export function fetchStatus(signal?: AbortSignal): Promise<ApiResult<StatusPayload>> {
  return apiGet("/api/status", signal);
}

/** The landing view. Default settings hit a single precomputed KV read. */
export function fetchBands(
  settings: Settings,
  signal?: AbortSignal,
): Promise<ApiResult<BandScanPayload>> {
  return apiGet(`/api/bands${queryString(toBandQuery(settings))}`, signal);
}

export function fetchBand(
  tag: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<ApiResult<BandPayload>> {
  return apiGet(
    `/api/bands/${encodeURIComponent(tag)}${queryString(toBandQuery(settings))}`,
    signal,
  );
}

/** Compaction and anvil in ONE ranked list — they compete for the same capital, so a
 *  split leaderboard would hide the comparison that matters (CLAUDE.md §8). */
export function fetchScan(
  settings: Settings,
  signal?: AbortSignal,
): Promise<ApiResult<readonly ScanRow[]>> {
  return apiGet(`/api/scan${queryString(toScanQuery(settings))}`, signal);
}

export function fetchCraft(
  baseTag: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<ApiResult<readonly CraftRow[]>> {
  return apiGet(
    `/api/craft/${encodeURIComponent(baseTag)}${queryString(toScanQuery(settings))}`,
    signal,
  );
}

export function fetchItem(
  tag: string,
  signal?: AbortSignal,
): Promise<ApiResult<ItemStatsPayload>> {
  return apiGet(`/api/item/${encodeURIComponent(tag)}`, signal);
}

export function fetchItemHistory(
  tag: string,
  range: ItemHistoryRange,
  signal?: AbortSignal,
): Promise<ApiResult<readonly ChartPoint[]>> {
  return apiGet(`/api/item/${encodeURIComponent(tag)}/history?range=${range}`, signal);
}

export function fetchItemHours(
  tag: string,
  days: number,
  signal?: AbortSignal,
): Promise<ApiResult<HourProfilePayload>> {
  return apiGet(`/api/item/${encodeURIComponent(tag)}/hours?days=${days}`, signal);
}

/** `verified` flags included — an unverified ratio must be visually marked, and every
 *  anvil recipe ships unverified, so the flag is load-bearing rather than an edge case. */
export function fetchRecipes(signal?: AbortSignal): Promise<ApiResult<RecipesPayload>> {
  return apiGet("/api/recipes", signal);
}

/** The catalogue, for the item index. Navigation, not analysis — no prices on it. */
export function fetchProducts(signal?: AbortSignal): Promise<ApiResult<ProductsPayload>> {
  return apiGet("/api/products", signal);
}
