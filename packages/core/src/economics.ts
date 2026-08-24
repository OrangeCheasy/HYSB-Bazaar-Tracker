import type { Hour } from "./profile.js";
import { parityPrice, type Recipe } from "./recipes.js";
import { err, ok, type Result } from "./result.js";
import type { Stats } from "./stats.js";

/**
 * The craft profit model.
 *
 * Three scenarios, because a single margin number is a lie. From CLAUDE.md section 1:
 * a buy order fills near the bid, a sell offer fills near the ask, so the optimistic
 * bid-to-ask case is only reachable if BOTH orders fill. Every scenario therefore ships
 * with a fill-feasibility figure, and the type makes that field non-optional so the UI
 * cannot render a margin without it (CLAUDE.md section 7.5).
 */

export type ScenarioKind = "instant" | "mixed" | "orders";

export interface MarketConfig {
  /** 0.0125 base, 0.01 with Bazaar Flipper II, ~0.0225 under Mayor Aura. User-adjustable. */
  readonly sellTaxRate: number;
  /** Share of observed daily flow you can realistically take. The most fragile input. */
  readonly captureFraction: number;
  /** UTC hours the player is not online to craft. Scales throughput, not order fills. */
  readonly sleepHours?: readonly Hour[];
}

export interface ScenarioResult {
  readonly kind: ScenarioKind;
  readonly baseUnitPrice: number;
  readonly productUnitPrice: number;
  readonly costPerCraft: number;
  readonly grossPerCraft: number;
  readonly taxPerCraft: number;
  readonly profitPerCraft: number;
  readonly marginPct: number;
  /** 0..1. Never render a margin without this next to it. */
  readonly fillFeasibility: number;
}

export interface Throughput {
  readonly baseUnitsPerDay: number;
  readonly productUnitsPerDay: number;
  readonly craftsPerDay: number;
  readonly limitedBy: "base-supply" | "product-demand" | "capital";
}

export type WarningFlag =
  | "unverified-recipe"
  | "implausible-margin"
  | "thin-base-volume"
  | "thin-product-volume"
  | "wide-spread"
  | "stale-data"
  | "single-sided-book"
  | "below-ratio-parity";

export interface CraftInputs {
  readonly recipe: Recipe;
  readonly base: Stats;
  readonly product: Stats;
  readonly market: MarketConfig;
  readonly capitalAvailable?: number;
  /** UTC epoch seconds "now", for the staleness check. */
  readonly asOf: number;
}

export interface CraftAnalysis {
  readonly recipe: Recipe;
  readonly scenarios: Readonly<Record<ScenarioKind, ScenarioResult>>;
  readonly throughput: Throughput;
  /** The ranking key. Never rank the scan by margin (CLAUDE.md section 8). */
  readonly profitPerDay: number;
  readonly capitalRequired: number;
  readonly flags: readonly WarningFlag[];
}

export type EconomicsError = "zero-ratio" | "zero-price" | "incomparable-windows";

/**
 * Real craft spreads are 1–5%. Anything past this means the recipe is wrong, the item is
 * dead, or someone is walling it — not that you found free money.
 */
const IMPLAUSIBLE_MARGIN_PCT = 0.5;
const THIN_FLOW_UNITS_PER_DAY = 1000;
const WIDE_SPREAD_PCT = 0.15;
const STALE_AFTER_SECONDS = 3 * 3600;

/** Tax applies when you sell. It never applies to buying. */
export function applySellTax(gross: number, rate: number): number {
  return gross - gross * rate;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * How likely a resting order is to fill: the daily flow that hits this side, against the
 * queue already ahead of you plus the size you are trying to add.
 */
function orderFeasibility(flowPerDay: number, queueAhead: number, myUnits: number): number {
  const denominator = queueAhead + myUnits;
  if (denominator <= 0) return flowPerDay > 0 ? 1 : 0;
  return clamp01(flowPerDay / denominator);
}

export function computeThroughput(
  base: Stats,
  product: Stats,
  recipe: Recipe,
  market: MarketConfig,
): Throughput {
  // Instant-SELLS into the base book are what fill MY buy order for the base.
  const baseUnitsPerDay = base.isPerDay * market.captureFraction;
  // Instant-BUYS out of the product book are what fill MY sell offer for the product.
  const productUnitsPerDay = product.ibPerDay * market.captureFraction;

  const craftsFromBase = baseUnitsPerDay / recipe.ratio;
  const craftsFromProduct = productUnitsPerDay;

  const sleeping = market.sleepHours?.length ?? 0;
  const activeFraction = Math.max(0, 24 - sleeping) / 24;

  const craftsPerDay = Math.min(craftsFromBase, craftsFromProduct) * activeFraction;

  return {
    baseUnitsPerDay,
    productUnitsPerDay,
    craftsPerDay,
    limitedBy: craftsFromBase <= craftsFromProduct ? "base-supply" : "product-demand",
  };
}

export function detectFlags(
  inputs: CraftInputs,
  scenarios: Readonly<Record<ScenarioKind, ScenarioResult>>,
): readonly WarningFlag[] {
  const { base, product, recipe, asOf } = inputs;
  const flags: WarningFlag[] = [];

  if (!recipe.verified) flags.push("unverified-recipe");
  if (scenarios.orders.marginPct > IMPLAUSIBLE_MARGIN_PCT) flags.push("implausible-margin");
  if (base.isPerDay < THIN_FLOW_UNITS_PER_DAY) flags.push("thin-base-volume");
  if (product.ibPerDay < THIN_FLOW_UNITS_PER_DAY) flags.push("thin-product-volume");
  if (base.spreadPctMean > WIDE_SPREAD_PCT || product.spreadPctMean > WIDE_SPREAD_PCT) {
    flags.push("wide-spread");
  }
  if (asOf - Math.max(base.to, product.to) > STALE_AFTER_SECONDS) flags.push("stale-data");
  if (
    base.askDepthMean === 0 ||
    base.bidDepthMean === 0 ||
    product.askDepthMean === 0 ||
    product.bidDepthMean === 0
  ) {
    flags.push("single-sided-book");
  }
  // Super Compactor 3000 minions dump price-insensitive enchanted supply, so popular
  // materials routinely trade BELOW their own parity. Not a bug; worth saying out loud.
  if (product.askMean < parityPrice(base.askMean, recipe)) flags.push("below-ratio-parity");

  return flags;
}

export function analyzeCraft(inputs: CraftInputs): Result<CraftAnalysis, EconomicsError> {
  const { recipe, base, product, market, capitalAvailable } = inputs;

  if (!Number.isFinite(recipe.ratio) || recipe.ratio <= 0) return err("zero-ratio");

  // Comparing series that cover different windows produces a number with no meaning.
  // One bar of slack, because the two rollups need not land on the same tick.
  const tolerance = Math.max(base.intervalSeconds, product.intervalSeconds);
  if (
    Math.abs(base.from - product.from) > tolerance ||
    Math.abs(base.to - product.to) > tolerance
  ) {
    return err("incomparable-windows");
  }

  const throughput = withCapitalCap(
    computeThroughput(base, product, recipe, market),
    base.bidMean * recipe.ratio,
    capitalAvailable,
  );

  // An item with no resting buy orders has bid 0, which makes both order-based scenarios
  // free and their margins infinite. Refusing is deliberate: a row reading "Infinity%"
  // on the scan page is worse than an absent row.
  const priced = [base.askMean, base.bidMean, product.askMean, product.bidMean];
  if (priced.some((p) => !Number.isFinite(p) || p <= 0)) return err("zero-price");

  const baseUnitsNeeded = recipe.ratio * throughput.craftsPerDay;
  const buyFill = orderFeasibility(base.isPerDay, base.bidDepthMean, baseUnitsNeeded);
  const sellFill = orderFeasibility(
    product.ibPerDay,
    product.askDepthMean,
    throughput.craftsPerDay,
  );

  const build = (
    kind: ScenarioKind,
    baseUnitPrice: number,
    productUnitPrice: number,
    fillFeasibility: number,
  ): ScenarioResult => {
    const costPerCraft = baseUnitPrice * recipe.ratio;
    const grossPerCraft = productUnitPrice;
    const taxPerCraft = grossPerCraft * market.sellTaxRate;
    const profitPerCraft = grossPerCraft - taxPerCraft - costPerCraft;
    return {
      kind,
      baseUnitPrice,
      productUnitPrice,
      costPerCraft,
      grossPerCraft,
      taxPerCraft,
      profitPerCraft,
      marginPct: profitPerCraft / costPerCraft,
      fillFeasibility,
    };
  };

  const scenarios = {
    // Instant-buy the base, instant-sell the product. Always achievable — the floor.
    instant: build("instant", base.askMean, product.bidMean, 1),
    // Buy order on the base, instant-sell the product. One order must fill.
    mixed: build("mixed", base.bidMean, product.bidMean, buyFill),
    // Buy order on the base, sell offer on the product. BOTH must fill. The headline
    // number, and the one that lies if you read it without its feasibility.
    orders: build("orders", base.bidMean, product.askMean, buyFill * sellFill),
  } as const;

  return ok({
    recipe,
    scenarios,
    throughput,
    profitPerDay: scenarios.orders.profitPerCraft * throughput.craftsPerDay,
    capitalRequired: scenarios.orders.costPerCraft * throughput.craftsPerDay,
    flags: detectFlags(inputs, scenarios),
  });
}

/**
 * Cap throughput by the wallet.
 *
 * Costed at the `orders` basis, matching `capitalRequired` — that is the scenario the
 * scan headline reports, so the capital figure the user sees is the one being capped.
 */
function withCapitalCap(
  throughput: Throughput,
  costPerCraft: number,
  capitalAvailable: number | undefined,
): Throughput {
  if (capitalAvailable === undefined || costPerCraft <= 0) return throughput;
  const craftsFromCapital = capitalAvailable / costPerCraft;
  if (craftsFromCapital >= throughput.craftsPerDay) return throughput;
  return { ...throughput, craftsPerDay: craftsFromCapital, limitedBy: "capital" };
}
