import { parityPrice, type Recipe } from "./recipes.js";
import { err, ok, type Result } from "./result.js";
import type { Stats } from "./stats.js";

/**
 * The craft profit model, ported from bzcraft/model.py `craft_economics`.
 *
 * Three scenarios, because a single margin number is a lie. From CLAUDE.md section 1:
 * a buy order fills near the bid, a sell offer fills near the ask, so the optimistic
 * bid-to-ask case is only reachable if BOTH orders fill.
 *
 *   floor   instant-buy the base, instant-sell the product. Worst case, always available.
 *   orders  buy order and sell offer on the CURRENT book, each stepped by one tick.
 *   timed   the same orders, but priced from the cheap and dear hours of the day.
 *
 * `timed` is the headline and the reason the site exists — the diurnal edge is the whole
 * premise. It falls back to `orders` pricing when no hour profile is available, matching
 * the Python.
 */

export type ScenarioKind = "floor" | "orders" | "timed";

export interface MarketConfig {
  /** 0.0125 base, 0.01 with Bazaar Flipper II, ~0.0225 under Mayor Aura. User-adjustable. */
  readonly sellTaxRate: number;
  /**
   * Fraction of total market flow you realistically capture. You are not the only person
   * running this craft; model.py puts 0.15–0.3 as honest for a popular item.
   */
  readonly captureFraction: number;
  /**
   * Coins per unit you outbid or undercut by to sit at the front of the queue.
   *
   * Without this the model prices your order AT the current best, i.e. behind everyone
   * already there, while assuming it fills like the best order in the book.
   */
  readonly tick: number;
  /**
   * Whether an instant-sell is taxed as well as a sell offer. Defaults to `true`.
   *
   * model.py taxes it — `floor_revenue_net = ench.last_bid * (1 - tax)` is an instant-sell
   * with the tax applied — which confirms the conservative default. Kept as a flag rather
   * than a constant because CLAUDE.md section 8 words it ambiguously. See ADR-008.
   */
  readonly taxOnInstantSell?: boolean;
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
  readonly craftsFromSupply: number;
  readonly craftsFromDemand: number;
  readonly craftsPerDay: number;
  readonly limitedBy: "base-supply" | "product-demand" | "capital";
  /** Hours of base flow needed to accumulate one craft's worth. Infinity if none flows. */
  readonly hoursToFillOneCraft: number;
}

export type WarningFlag =
  | "unverified-recipe"
  | "implausible-margin"
  | "deep-buy-queue"
  | "product-rarely-instant-bought"
  | "volatile-base"
  | "profit-needs-both-fills"
  | "slow-fill"
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
  /**
   * Raw window prices from the hour profile, BEFORE the tick is applied — this function
   * steps inside them exactly as it does for the current book, so the tick is applied in
   * one place rather than at every call site.
   *
   * `timedBuyWindowBid` is the mean bid over the hours your buy order sits unattended
   * (the sleep window), NOT the cheapest hours of the day. Those are different questions:
   * the order fills at whatever the book does while you are asleep, so that is the price
   * to plan against. `bzcraft.py` line 207.
   *
   * `timedSellWindowAsk` is the mean ask over the dearest window, from `bestSellWindow`.
   *
   * Both are supplied by the caller rather than computed here, so economics stays
   * independent of profile — the same seam model.py uses.
   */
  readonly timedBuyWindowBid?: number;
  readonly timedSellWindowAsk?: number;
  /** UTC epoch seconds "now", for the staleness check. */
  readonly asOf: number;
}

export interface CraftAnalysis {
  readonly recipe: Recipe;
  readonly scenarios: Readonly<Record<ScenarioKind, ScenarioResult>>;
  readonly throughput: Throughput;
  /** The ranking key, from the TIMED scenario. Never rank by margin (CLAUDE.md section 8). */
  readonly profitPerDay: number;
  /** Coins tied up in one craft, at timed pricing. */
  readonly capitalPerCraft: number;
  /** Coins tied up running a full day of crafts. */
  readonly capitalRequired: number;
  readonly flags: readonly WarningFlag[];
}

export type EconomicsError = "zero-ratio" | "zero-price" | "incomparable-windows";

/**
 * Real craft spreads are 1–5%. Anything past this means the recipe is wrong, the item is
 * dead, or someone is walling it — not that you found free money.
 */
const IMPLAUSIBLE_MARGIN_PCT = 0.5;
const WIDE_SPREAD_PCT = 0.15;
const STALE_AFTER_SECONDS = 3 * 3600;
/** model.py thresholds, kept as-is: they encode play experience, not statistics. */
const DEEP_QUEUE_HOURS = 48;
const SLOW_FILL_HOURS = 14;
const VOLATILE_BASE_PCT = 0.12;
const RARELY_BOUGHT_PER_HOUR = 1;

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
 *
 * Not from model.py, which reports queue depth as free-text notes instead. CLAUDE.md
 * section 7.5 requires a number adjacent to every margin, so this quantifies the same
 * idea. It is an ordering signal, not a probability — see ADR-007.
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
  const baseUnitsPerDay = base.isPerHour * 24 * market.captureFraction;
  // Instant-BUYS out of the product book are what fill MY sell offer for the product.
  const productUnitsPerDay = product.ibPerHour * 24 * market.captureFraction;

  const craftsFromSupply = baseUnitsPerDay / recipe.ratio;
  const craftsFromDemand = productUnitsPerDay;

  const capturedFlowPerHour = base.isPerHour * market.captureFraction;
  const hoursToFillOneCraft =
    capturedFlowPerHour > 0 ? recipe.ratio / capturedFlowPerHour : Number.POSITIVE_INFINITY;

  return {
    baseUnitsPerDay,
    productUnitsPerDay,
    craftsFromSupply,
    craftsFromDemand,
    // Deliberately NOT scaled by the player's waking hours. Buy orders fill overnight
    // while you sleep — that is the entire premise — and crafting a day's worth takes
    // seconds once the materials are in. Throughput is bounded by market flow, not by
    // how long you are logged in. model.py `craft_economics` takes no sleep parameter.
    craftsPerDay: Math.min(craftsFromSupply, craftsFromDemand),
    limitedBy: craftsFromSupply <= craftsFromDemand ? "base-supply" : "product-demand",
    hoursToFillOneCraft,
  };
}

export function detectFlags(
  inputs: CraftInputs,
  scenarios: Readonly<Record<ScenarioKind, ScenarioResult>>,
  throughput: Throughput,
): readonly WarningFlag[] {
  const { base, product, recipe, asOf } = inputs;
  const flags: WarningFlag[] = [];

  if (!recipe.verified) flags.push("unverified-recipe");
  if (scenarios.timed.marginPct > IMPLAUSIBLE_MARGIN_PCT) flags.push("implausible-margin");

  // How many hours of instant-sell flow are already queued ahead of your buy order.
  if (base.lastBidDepth > 0 && base.isPerHour > 0) {
    if (base.lastBidDepth / base.isPerHour > DEEP_QUEUE_HOURS) flags.push("deep-buy-queue");
  }
  if (product.ibPerHour < RARELY_BOUGHT_PER_HOUR) flags.push("product-rarely-instant-bought");
  if (base.volatility > VOLATILE_BASE_PCT) flags.push("volatile-base");
  // The one that matters most: the craft only works if both orders fill.
  if (scenarios.timed.profitPerCraft > 0 && scenarios.floor.profitPerCraft < 0) {
    flags.push("profit-needs-both-fills");
  }
  if (throughput.hoursToFillOneCraft > SLOW_FILL_HOURS) flags.push("slow-fill");

  if (base.spreadPct > WIDE_SPREAD_PCT || product.spreadPct > WIDE_SPREAD_PCT) {
    flags.push("wide-spread");
  }
  if (asOf - Math.max(base.to, product.to) > STALE_AFTER_SECONDS) flags.push("stale-data");
  if (
    base.lastAskDepth === 0 ||
    base.lastBidDepth === 0 ||
    product.lastAskDepth === 0 ||
    product.lastBidDepth === 0
  ) {
    flags.push("single-sided-book");
  }
  // Super Compactor 3000 minions dump price-insensitive enchanted supply, so popular
  // materials routinely trade BELOW their own parity. Not a bug; worth saying out loud.
  if (product.lastAsk < parityPrice(base.lastAsk, recipe)) flags.push("below-ratio-parity");

  return flags;
}

export function analyzeCraft(inputs: CraftInputs): Result<CraftAnalysis, EconomicsError> {
  const { recipe, base, product, market, capitalAvailable } = inputs;
  const { timedBuyWindowBid, timedSellWindowAsk } = inputs;

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

  // model.py drops any point where ask or bid is non-positive before it reaches the
  // economics. We keep such points in D1 (a zero bid is real history worth storing) and
  // reject here instead: an item with no resting buy orders has bid 0, which makes the
  // order scenarios free and their margins infinite. A row reading "Infinity%" on the
  // scan page is worse than an absent row.
  const priced = [base.lastAsk, base.lastBid, product.lastAsk, product.lastBid];
  if (priced.some((p) => !Number.isFinite(p) || p <= 0)) return err("zero-price");

  const throughput = withCapitalCap(
    computeThroughput(base, product, recipe, market),
    (base.lastBid + market.tick) * recipe.ratio,
    capitalAvailable,
  );

  const baseUnitsNeeded = recipe.ratio * throughput.craftsPerDay;
  const buyFill = orderFeasibility(base.isPerDay, base.lastBidDepth, baseUnitsNeeded);
  const sellFill = orderFeasibility(
    product.ibPerDay,
    product.lastAskDepth,
    throughput.craftsPerDay,
  );

  // A sell offer is always taxed. Whether an instant-sell is too is the one genuinely
  // ambiguous rule in the model, so it is a config flag rather than a silent constant.
  const taxesInstantSell = market.taxOnInstantSell ?? true;

  const build = (
    kind: ScenarioKind,
    baseUnitPrice: number,
    productUnitPrice: number,
    fillFeasibility: number,
    taxed: boolean,
  ): ScenarioResult => {
    const costPerCraft = baseUnitPrice * recipe.ratio;
    const grossPerCraft = productUnitPrice;
    const taxPerCraft = taxed ? grossPerCraft * market.sellTaxRate : 0;
    const profitPerCraft = grossPerCraft - taxPerCraft - costPerCraft;
    return {
      kind,
      baseUnitPrice,
      productUnitPrice,
      costPerCraft,
      grossPerCraft,
      taxPerCraft,
      profitPerCraft,
      marginPct: costPerCraft === 0 ? 0 : profitPerCraft / costPerCraft,
      fillFeasibility,
    };
  };

  // Step inside the best resting price on each side, so your order sits at the front of
  // the queue rather than behind everyone already at that price.
  const stepIn = (bid: number): number => bid + market.tick;
  const undercut = (ask: number): number => Math.max(ask - market.tick, 0);

  const orderBuy = stepIn(base.lastBid);
  const orderSell = undercut(product.lastAsk);

  // Fall back to the current book when no hour profile was supplied, matching
  // model.py's `timed_buy_price if timed_buy_price else order_buy`.
  const usableWindow = (v: number | undefined): v is number => v !== undefined && v > 0;

  const scenarios = {
    // Instant-buy the base, instant-sell the product. Always achievable — the floor.
    floor: build("floor", base.lastAsk, product.lastBid, 1, taxesInstantSell),
    // Orders on both sides of the current book. BOTH must fill.
    orders: build("orders", orderBuy, orderSell, buyFill * sellFill, true),
    // The same orders, priced from the overnight and peak windows. The headline, and the
    // one that lies if you read it without its feasibility.
    timed: build(
      "timed",
      usableWindow(timedBuyWindowBid) ? stepIn(timedBuyWindowBid) : orderBuy,
      usableWindow(timedSellWindowAsk) ? undercut(timedSellWindowAsk) : orderSell,
      buyFill * sellFill,
      true,
    ),
  } as const;

  return ok({
    recipe,
    scenarios,
    throughput,
    profitPerDay: scenarios.timed.profitPerCraft * throughput.craftsPerDay,
    capitalPerCraft: scenarios.timed.costPerCraft,
    capitalRequired: scenarios.timed.costPerCraft * throughput.craftsPerDay,
    flags: detectFlags(inputs, scenarios, throughput),
  });
}

/**
 * Cap throughput by the wallet.
 *
 * Costed at the order basis, which is what `capitalRequired` reports, so the capital
 * figure the user sees is the one being capped.
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
