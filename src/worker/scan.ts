import {
  DEFAULT_SCAN_QUERY,
  SCAN_PARAM_RANGES,
  bestSellWindow,
  bookTagFor,
  checkParam,
  cheapestPath,
  computeHourProfile,
  detectMergeGates,
  computeStats,
  hourRange,
  meanOverHours,
  normalizeHourlyRow,
  normalizeMany,
  parseBookTag,
  sliceWindow,
  analyzeCraft,
  type ScanParamName,
  type ScanRow,
  type Bar,
  type ConversionEdge,
  type CraftAnalysis,
  type HourProfile,
  type MarketConfig,
  type Recipe,
} from "@core/index.js";
import { selectHourlyBarsForTag } from "./db/history.js";
import { selectRecipesByKind, type RecipeRow } from "./db/recipes.js";

/**
 * Orchestration shared by `/api/scan`, `/api/craft/:baseTag`, and `precompute.ts`: pull
 * hourly bars for the tags a recipe touches, run them through packages/core, and rank
 * the result. Kept out of `src/worker/api/` — route handlers stay thin (parse request,
 * call this, shape the envelope) — and out of `packages/core`, since fetching from D1
 * is exactly the platform I/O core is not allowed to do.
 */

/** The numbers themselves live in `DEFAULT_SCAN_QUERY` (packages/core/src/params.ts),
 *  alongside the ranges that validate them, so the Worker and the settings drawer cannot
 *  disagree about what "unset" means — which matters because `/api/scan` only takes the
 *  KV fast path when every parameter is exactly the default. */
export const DEFAULT_MARKET: MarketConfig = {
  sellTaxRate: DEFAULT_SCAN_QUERY.tax,
  captureFraction: DEFAULT_SCAN_QUERY.capture,
  tick: DEFAULT_SCAN_QUERY.tick,
  taxOnInstantSell: true,
};

/** Default overnight buy window, UTC. `timedBuyWindowBid` averages the bid over this
 *  FIXED span (CLAUDE.md's "the hours your order sits unattended"), not the cheapest
 *  hours found by search — that distinction is packages/core/economics.ts's, not ours. */
export const DEFAULT_SLEEP_START = DEFAULT_SCAN_QUERY.sleepStart;
export const DEFAULT_SLEEP_END = DEFAULT_SCAN_QUERY.sleepEnd;

/** Length of the searched sell window; the search itself picks WHEN. */
export const DEFAULT_SELL_WINDOW_HOURS = DEFAULT_SCAN_QUERY.window;

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
  const productStats = computeStats(
    productWindow.length > 0 ? productWindow : productSeries.bars,
  );
  if (!baseStats.ok) return { error: baseStats.error, dataTo };
  if (!productStats.ok) return { error: productStats.error, dataTo };

  const baseProfile = computeHourProfile(baseSeries.bars);
  const productProfile = computeHourProfile(productSeries.bars);
  const timedBuyWindowBid = baseProfile.ok ? timedBuyBid(baseProfile.value, params) : undefined;
  const timedSellWindowAsk = productProfile.ok
    ? timedSellAsk(productProfile.value, params)
    : undefined;

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

/** One scan row: recipe, its analysis (or why there isn't one), which craft type produced
 *  it, and for anvil the chosen route. Shape lives in `packages/core/src/wire.ts` — it is
 *  what `/api/scan` puts on the wire, so the client must be able to import it without
 *  reaching into `src/worker/`. Re-exported here because this is where it is built. */
export type { ScanRow };

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
  // Compaction only. Anvil edges live in the same table but are graph data, not scan
  // rows: one row per 2:1 merge would be ~620 rows of noise, and at two series fetches
  // per recipe it would put this loop at ~1,328 D1 queries against a hard cap of 1,000
  // (CLAUDE.md section 3). Merges are scanned per FAMILY instead — buy at the cheapest
  // rung, merge up, sell — which is the opportunity anyone actually acts on and the
  // reason the Part A solver searches entry levels at all.
  const recipeRows = await selectRecipesByKind(db, "compact");
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

  const anvil = await runAnvilScan(db, params, now, capitalAvailable);
  if (anvil.dataTo < dataTo) dataTo = anvil.dataTo;

  const compactRows: ScanRow[] = [...successful, ...failed].map(
    ({ recipe, analysis, error }) => ({ recipe, analysis, error, kind: "compact" as const }),
  );

  // One ranked list, not two. Compaction and anvil compete for the same capital, so they
  // sort together by profit/day — which is volume-adjusted throughput times margin, never
  // margin alone (CLAUDE.md section 8). Rows with no analysis sort last rather than being
  // dropped: "no data yet" is information.
  const all = [...compactRows, ...anvil.rows];
  const scored = all.filter((r) => r.analysis !== undefined);
  const unscored = all.filter((r) => r.analysis === undefined);
  scored.sort((a, b) => (b.analysis?.profitPerDay ?? 0) - (a.analysis?.profitPerDay ?? 0));

  return {
    rows: [...scored, ...unscored],
    dataTo: scored.length > 0 ? dataTo : now,
  };
}

export type ScanQueryParams = { params: ScanParams; capitalAvailable?: number };
export type ParseResult =
  | { readonly ok: true; readonly value: ScanQueryParams }
  | { readonly ok: false; readonly error: string };

/** Parsed from `?tax=&capture=&tick=&sleepStart=&sleepEnd=&window=&capital=`. Shared by
 *  `/api/scan` and `/api/craft/:baseTag` so the same query string means the same thing
 *  on both (ROADMAP Phase 7: "shareable craft links").
 *
 *  Out-of-range and non-numeric values are rejected rather than clamped or silently
 *  replaced by the default. A scan is a number someone may act on with real coins
 *  (CLAUDE.md section 7.6), and quietly substituting a different tax rate than the one
 *  asked for produces a plausible-looking answer to a question nobody asked. */
export function parseScanQueryParams(url: URL): ParseResult {
  const sp = url.searchParams;
  let failure: string | undefined;

  // First failure wins and parsing continues, rather than returning early: reporting the
  // first bad parameter is enough to act on, and the straight-line shape below stays
  // readable. Ranges and messages come from core so the settings drawer validates against
  // the identical table (packages/core/src/params.ts).
  const num = (key: ScanParamName, fallback: number): number => {
    const checked = checkParam(key, SCAN_PARAM_RANGES[key], sp.get(key), fallback);
    if (checked.ok) return checked.value;
    failure ??= checked.message;
    return fallback;
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

  // Sentinel rather than a range: absent `capital` means "no capital constraint", which
  // is a different scan from one constrained to 0 coins.
  const capitalRaw = sp.get("capital");
  const capitalAvailable =
    capitalRaw === null || capitalRaw === "" ? undefined : num("capital", 0);

  if (failure !== undefined) return { ok: false, error: failure };
  return { ok: true, value: { params, capitalAvailable } };
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

/**
 * Latest ask per book tag, in ONE query.
 *
 * This is the whole reason anvil scanning fits inside D1's 1,000-query-per-invocation cap.
 * The solver needs a price for every rung to choose an entry level — 777 of them — and
 * fetching those one at a time the way buildCraftAnalysis fetches a series would blow the
 * budget on its own. Reading `hourly` rather than `snapshots` is deliberate: intermediate
 * rungs are Tier B and have no five-minute rows, so `snapshots` would silently return
 * nothing for exactly the levels the entry search exists to consider.
 */
export async function fetchBookAskPrices(
  db: Pick<D1Database, "prepare">,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      // Latest price PER TAG, not the latest hour globally. The current hour is partial,
      // and a thin book may simply not have traded in it: `ENCHANTMENT_LOOTING_5` had no
      // 04:00 row while `ENCHANTMENT_LOOTING_4` did. Keying off one global MAX(hour_ts)
      // priced 482 of 777 book tags; per-tag prices all 777 — and the 295 it dropped were
      // disproportionately the thin, high-value top rungs this scan exists to evaluate.
      //
      // SQLite's bare-column-with-MAX() rule makes this one grouped pass: `ask_avg` is
      // taken from the same row that produced MAX(hour_ts). Bounded to a 48h lookback so
      // the scan never prices a chain off a week-old quote.
      //
      // substr() rather than LIKE 'ENCHANTMENT_%': in LIKE, `_` is a single-character
      // wildcard, so that pattern would also match a hypothetical ENCHANTMENTS_ tag.
      `SELECT tag, ask_avg, MAX(hour_ts) AS hour_ts FROM hourly
        WHERE substr(tag, 1, 12) = 'ENCHANTMENT_'
          AND hour_ts >= (SELECT MAX(hour_ts) - 172800 FROM hourly)
        GROUP BY tag`,
    )
    .all<{ tag: string; ask_avg: number }>();

  const prices = new Map<string, number>();
  for (const r of results) {
    if (Number.isFinite(r.ask_avg) && r.ask_avg > 0) prices.set(r.tag, r.ask_avg);
  }
  return prices;
}

/**
 * One row per enchant family: buy at the cheapest rung, merge up to the top rung, sell.
 *
 * Deliberately NOT one row per edge. A single 2:1 merge is not something anyone acts on,
 * and 620 of them would be ~1,328 D1 queries against a cap of 1,000 plus a ~1MB KV payload
 * of noise. The opportunity is the whole chain, and choosing where to enter it is what the
 * Part A solver is for.
 *
 * The chain is then priced by the SAME `analyzeCraft` that prices compaction. Once the
 * solver has picked an entry, "64 books of level 1 make one level 7" is structurally
 * identical to "160 sugar make one enchanted sugar" — so throughput, fill feasibility,
 * flags and profit/day all come from one implementation rather than a parallel one.
 */
export async function runAnvilScan(
  db: Pick<D1Database, "prepare">,
  params: ScanParams,
  now: number,
  capitalAvailable?: number,
): Promise<{ readonly rows: readonly ScanRow[]; readonly dataTo: number }> {
  const anvilRecipes = await selectRecipesByKind(db, "anvil");
  if (anvilRecipes.length === 0) return { rows: [], dataTo: now };

  const edges: ConversionEdge[] = anvilRecipes.map((r) => ({
    from: r.base_tag,
    to: r.ench_tag,
    inputPerOutput: r.ratio,
    // Zero until the anvil fee is confirmed in-game (CLAUDE.md section 8). Not a constant
    // to invent here — a wrong fee is a wrong margin on every book in the catalogue.
    stepCost: 0,
    kind: "anvil",
    verified: r.verified !== 0,
    recipeId: r.id,
  }));

  const prices = await fetchBookAskPrices(db);
  const priceOf = (tag: string): number | null => prices.get(tag) ?? null;

  // Withhold rungs the market says cannot be merged into. A top rung worth 1,500x its
  // inputs is not a spectacular trade — it is a book the game only hands out somewhere
  // else, so the conversion does not exist and the margin is unexecutable. Dropping the
  // gated edge re-targets the family at the highest rung a merge CAN actually reach,
  // rather than parking a fantasy at the top of the ranking. See detectMergeGates.
  const { usable: mergeableEdges, gated } = detectMergeGates(edges, priceOf);
  if (gated.length > 0) {
    let worst = gated[0];
    for (const g of gated) if (worst && g.impliedRatio > worst.impliedRatio) worst = g;
    console.log(
      `anvil scan: ${gated.length} edge(s) withheld as un-mergeable; ` +
        `worst ${worst?.edge.to} at ${worst?.impliedRatio.toFixed(0)}x implied`,
    );
  }

  /** Target the top rung of each family — the one a merge strategy actually sells. */
  const topLevel = new Map<string, number>();
  for (const e of mergeableEdges) {
    const parsed = parseBookTag(e.to);
    if (!parsed) continue;
    const current = topLevel.get(parsed.family);
    if (current === undefined || parsed.level > current) {
      topLevel.set(parsed.family, parsed.level);
    }
  }

  let dataTo = now;
  const rows: ScanRow[] = [];

  for (const [family, level] of topLevel) {
    const targetTag = bookTagFor(family, level);
    const solved = cheapestPath(targetTag, mergeableEdges, priceOf);
    if (!solved.ok) {
      rows.push({
        recipe: anvilRecipeShell(targetTag, targetTag, 1),
        error: solved.error,
        kind: "anvil",
      });
      continue;
    }

    const plan = solved.value;
    // No steps means buying the finished book beats every merge route. That is a real
    // answer, not a failure — but it is not a craft, so it is not a craft row.
    if (plan.steps.length === 0) continue;

    const recipe = anvilRecipeShell(plan.entryTag, targetTag, plan.entryUnits);
    const built = await buildCraftAnalysis(db, recipe, params, now, capitalAvailable);
    if (built.dataTo < dataTo) dataTo = built.dataTo;
    rows.push({ recipe, analysis: built.analysis, error: built.error, kind: "anvil", plan });
  }

  return { rows, dataTo };
}

/**
 * A synthetic Recipe standing for a whole merge chain: `ratio` is the solver's entryUnits,
 * so Sharpness 1 -> 7 arrives as ratio 64 rather than six separate ratio-2 rows.
 *
 * `verified: false` always. Anvil ratios are derived from tag names, and CLAUDE.md
 * section 8 is explicit that name matching cannot confirm a ratio — the fact that 2^k is
 * arithmetic rather than a guess does not make the CHAIN verified, because whether every
 * rung really merges is the unverified part.
 */
export function anvilRecipeShell(baseTag: string, enchTag: string, ratio: number): Recipe {
  return { id: null, baseTag, enchTag, ratio, verified: false, note: null };
}
