import {
  bestSellWindow,
  computeHourProfile,
  computeStats,
  hourRange,
  meanOverHours,
  normalizeHourlyRow,
  normalizeMany,
  sliceWindow,
  analyzeCraft,
  type Bar,
  type CraftAnalysis,
  type HourProfile,
  type MarketConfig,
  type Recipe,
} from "@core/index.js";
import { selectHourlyBarsForTag } from "./db/history.js";
import { selectAllRecipes, type RecipeRow } from "./db/recipes.js";

/**
 * Orchestration shared by `/api/scan`, `/api/craft/:baseTag`, and `precompute.ts`: pull
 * hourly bars for the tags a recipe touches, run them through packages/core, and rank
 * the result. Kept out of `src/worker/api/` — route handlers stay thin (parse request,
 * call this, shape the envelope) — and out of `packages/core`, since fetching from D1
 * is exactly the platform I/O core is not allowed to do.
 */

export const DEFAULT_MARKET: MarketConfig = {
  sellTaxRate: 0.0125,
  captureFraction: 0.2,
  // Flat 1-coin step. A single global tick is a simplification (a cheap material and a
  // pricey enchanted one deserve different step sizes), but it matches the shape of
  // MarketConfig today and is overridable per-request via `?tick=`.
  tick: 1,
  taxOnInstantSell: true,
};

/** Default overnight buy window, UTC. `timedBuyWindowBid` averages the bid over this
 *  FIXED span (CLAUDE.md's "the hours your order sits unattended"), not the cheapest
 *  hours found by search — that distinction is packages/core/economics.ts's, not ours. */
export const DEFAULT_SLEEP_START = 23;
export const DEFAULT_SLEEP_END = 7;

/** Length of the searched sell window; the search itself picks WHEN. */
export const DEFAULT_SELL_WINDOW_HOURS = 8;

/** How far back to fetch. One fetch covers both the hour-of-day profile (wants 14+
 *  days per ROADMAP Phase 3) and every Stats window up to 30d, via sliceWindow -- so
 *  a single query per tag serves both, rather than one for stats and a second for the
 *  profile. */
export const PROFILE_DAYS = 30;

/** The Stats window actually used for the craft economics — recent enough that a
 *  price move this week is not diluted by a month of history. */
export const STATS_WINDOW_DAYS = 7;

export interface ScanParams {
  readonly market: MarketConfig;
  readonly sleepStart: number;
  readonly sleepEnd: number;
  readonly sellWindowHours: number;
}

export const DEFAULT_SCAN_PARAMS: ScanParams = {
  market: DEFAULT_MARKET,
  sleepStart: DEFAULT_SLEEP_START,
  sleepEnd: DEFAULT_SLEEP_END,
  sellWindowHours: DEFAULT_SELL_WINDOW_HOURS,
};

export function toRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    baseTag: row.base_tag,
    enchTag: row.ench_tag,
    ratio: row.ratio,
    verified: row.verified !== 0,
    note: row.note,
  };
}

interface TagSeries {
  readonly bars: readonly Bar[];
  /** Newest bar's ts, or undefined for an empty series. The freshness this tag can
   *  honestly claim — never `Date.now()`, see buildCraftAnalysis. */
  readonly latestTs: number | undefined;
}

async function fetchTagSeries(
  db: Pick<D1Database, "prepare">,
  tag: string,
  sinceTs: number,
): Promise<TagSeries> {
  const rows = await selectHourlyBarsForTag(db, tag, sinceTs);
  const { ok: bars } = normalizeMany(rows, normalizeHourlyRow);
  // Loop rather than Math.max(...bars.map(...)) — stats.ts avoids the same spread for
  // the same reason (unbounded call-stack growth); 30 days of hourly bars is small
  // today but the pattern should not depend on staying small.
  let latestTs: number | undefined;
  for (const b of bars) {
    if (latestTs === undefined || b.ts > latestTs) latestTs = b.ts;
  }
  return { bars, latestTs };
}

function timedBuyBid(profile: HourProfile, params: ScanParams): number | undefined {
  return meanOverHours(profile, hourRange(params.sleepStart, params.sleepEnd), "bidMean");
}

function timedSellAsk(profile: HourProfile, params: ScanParams): number | undefined {
  const best = bestSellWindow(profile, params.sellWindowHours);
  if (!best) return undefined;
  return meanOverHours(
    profile,
    hourRange(best.startHour, best.startHour + best.lengthHours),
    "askMean",
  );
}

export interface CraftBuildResult {
  readonly analysis?: CraftAnalysis;
  readonly error?: string;
  /** The freshest timestamp this result can honestly claim — the OLDER of the base and
   *  product series' latest bar, since the whole analysis is only as fresh as its
   *  stalest input. Falls back to `now` only when there is no data at all, so an
   *  empty/errored result does not silently claim to be "fresh". */
  readonly dataTo: number;
}

export async function buildCraftAnalysis(
  db: Pick<D1Database, "prepare">,
  recipe: Recipe,
  params: ScanParams,
  now: number,
  capitalAvailable?: number,
): Promise<CraftBuildResult> {
  const sinceTs = now - PROFILE_DAYS * 86_400;
  const [baseSeries, productSeries] = await Promise.all([
    fetchTagSeries(db, recipe.baseTag, sinceTs),
    fetchTagSeries(db, recipe.enchTag, sinceTs),
  ]);

  if (baseSeries.latestTs === undefined) return { error: "no-base-data", dataTo: now };
  if (productSeries.latestTs === undefined) return { error: "no-product-data", dataTo: now };
  const dataTo = Math.min(baseSeries.latestTs, productSeries.latestTs);

  const statsSinceTs = now - STATS_WINDOW_DAYS * 86_400;
  const baseWindow = sliceWindow(baseSeries.bars, statsSinceTs, now);
  const productWindow = sliceWindow(productSeries.bars, statsSinceTs, now);

  const baseStats = computeStats(baseWindow.length > 0 ? baseWindow : baseSeries.bars);
  const productStats = computeStats(productWindow.length > 0 ? productWindow : productSeries.bars);
  if (!baseStats.ok) return { error: baseStats.error, dataTo };
  if (!productStats.ok) return { error: productStats.error, dataTo };

  const baseProfile = computeHourProfile(baseSeries.bars);
  const productProfile = computeHourProfile(productSeries.bars);
  const timedBuyWindowBid = baseProfile.ok ? timedBuyBid(baseProfile.value, params) : undefined;
  const timedSellWindowAsk = productProfile.ok ? timedSellAsk(productProfile.value, params) : undefined;

  const result = analyzeCraft({
    recipe,
    base: baseStats.value,
    product: productStats.value,
    market: params.market,
    capitalAvailable,
    timedBuyWindowBid,
    timedSellWindowAsk,
    asOf: now,
  });

  if (!result.ok) return { error: result.error, dataTo };
  return { analysis: result.value, dataTo };
}

export interface ScanRow {
  readonly recipe: Recipe;
  readonly analysis?: CraftAnalysis;
  readonly error?: string;
}

export interface ScanResult {
  readonly rows: readonly ScanRow[];
  /** Oldest "freshest data point" across every INCLUDED row — the whole payload is
   *  only as fresh as its stalest ingredient. `now` when nothing succeeded, so an
   *  all-empty scan does not falsely claim freshness. */
  readonly dataTo: number;
}

/** Every recipe, analyzed and ranked by profit/day (CLAUDE.md §8: never rank by
 *  margin). Failures are kept, not dropped — a recipe with no data yet is still worth
 *  showing as "unavailable" rather than silently vanishing from the list. */
export async function runScan(
  db: Pick<D1Database, "prepare">,
  params: ScanParams,
  now: number,
  capitalAvailable?: number,
): Promise<ScanResult> {
  const recipeRows = await selectAllRecipes(db);
  const recipes = recipeRows.map(toRecipe);

  const built = await Promise.all(
    recipes.map(async (recipe) => {
      const result = await buildCraftAnalysis(db, recipe, params, now, capitalAvailable);
      return { recipe, ...result };
    }),
  );

  const successful = built.filter(
    (r): r is typeof r & { analysis: CraftAnalysis } => r.analysis !== undefined,
  );
  successful.sort((a, b) => b.analysis.profitPerDay - a.analysis.profitPerDay);
  const failed = built.filter((r) => r.analysis === undefined);

  let dataTo = now;
  for (const r of successful) {
    if (r.dataTo < dataTo) dataTo = r.dataTo;
  }

  return {
    rows: [...successful, ...failed].map(({ recipe, analysis, error }) => ({
      recipe,
      analysis,
      error,
    })),
    dataTo: successful.length > 0 ? dataTo : now,
  };
}

/** Parsed from `?tax=&capture=&tick=&sleepStart=&sleepEnd=&window=&capital=`. Shared by
 *  `/api/scan` and `/api/craft/:baseTag` so the same query string means the same thing
 *  on both (ROADMAP Phase 7: "shareable craft links"). */
export function parseScanQueryParams(url: URL): {
  params: ScanParams;
  capitalAvailable?: number;
} {
  const sp = url.searchParams;
  const num = (key: string, fallback: number): number => {
    const raw = sp.get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const market: MarketConfig = {
    sellTaxRate: num("tax", DEFAULT_MARKET.sellTaxRate),
    captureFraction: num("capture", DEFAULT_MARKET.captureFraction),
    tick: num("tick", DEFAULT_MARKET.tick),
    taxOnInstantSell: DEFAULT_MARKET.taxOnInstantSell,
  };
  const params: ScanParams = {
    market,
    sleepStart: num("sleepStart", DEFAULT_SLEEP_START),
    sleepEnd: num("sleepEnd", DEFAULT_SLEEP_END),
    sellWindowHours: num("window", DEFAULT_SELL_WINDOW_HOURS),
  };

  const capitalRaw = sp.get("capital");
  const capitalParsed = capitalRaw === null ? NaN : Number(capitalRaw);
  const capitalAvailable = Number.isFinite(capitalParsed) ? capitalParsed : undefined;

  return { params, capitalAvailable };
}

/** True when every scan param is exactly the default — the KV-vs-live-D1 fork in
 *  `/api/scan` (ROADMAP Phase 4: "non-default parameters recompute from hourly"). */
export function isDefaultScanParams(
  params: ScanParams,
  capitalAvailable: number | undefined,
): boolean {
  return (
    capitalAvailable === undefined &&
    params.market.sellTaxRate === DEFAULT_MARKET.sellTaxRate &&
    params.market.captureFraction === DEFAULT_MARKET.captureFraction &&
    params.market.tick === DEFAULT_MARKET.tick &&
    params.sleepStart === DEFAULT_SLEEP_START &&
    params.sleepEnd === DEFAULT_SLEEP_END &&
    params.sellWindowHours === DEFAULT_SELL_WINDOW_HOURS
  );
}
