import { err, ok, type Result } from "./result.js";

/**
 * The conversion graph: what is the cheapest way to obtain one unit of a tag?
 *
 * A recipe stops being "base x ratio -> product" and becomes an edge. That reframing is
 * the whole point of this module (ADR-023): two problems that look unrelated are the same
 * problem, and solving them separately means finding the same class of bug twice.
 *
 *   - Anvil book chains. Two books of level N make one of level N+1, so reaching level M
 *     from level L costs 2^(M-L) books. Every rung in between is itself tradeable, so
 *     entering at level 3 is often cheaper than at level 1.
 *   - Multi-step compaction. SUGAR_CANE -> ENCHANTED_SUGAR -> ENCHANTED_SUGAR_CANE is a
 *     two-step path priced identically. Seeded as one 160:1 step it reported a ~3,000%
 *     margin and ranked first in production (migration 0006).
 *
 * There is no discriminated union here and no branching on craft type. `2^k` is not a
 * special edge shape — it emerges from composing k edges of `inputPerOutput: 2`.
 * Sharpness 1 -> 7 is six edges, and 64 falls out of the multiplication.
 */

export type ConversionKind = "compact" | "anvil";

export interface ConversionEdge {
  readonly from: string;
  readonly to: string;
  /** Units of `from` consumed per single unit of `to`. Integer >= 1. */
  readonly inputPerOutput: number;
  /**
   * Flat coins per conversion performed, charged once per unit of `to` produced — so a
   * 64-book chain pays this six times (once per merge level), not 64 times. Zero for
   * compaction. The anvil fee is UNVERIFIED (CLAUDE.md section 8): it defaults to zero and
   * any path that charges it is flagged, rather than being baked in as a constant.
   */
  readonly stepCost: number;
  /** Provenance, for flags and UI. The solver never reads this to decide anything. */
  readonly kind: ConversionKind;
  readonly verified: boolean;
  readonly recipeId: number | null;
}

/**
 * Price of one unit of `tag`, or null if it cannot be bought.
 *
 * A function rather than a map so this module stays ignorant of where prices come from
 * and, more importantly, of which SIDE of the book they came from. A buy order competes
 * at `bid` and an instant buy pays `ask` (CLAUDE.md section 1); that choice belongs to the
 * caller, and baking it in here would silently fix the scenario for every consumer.
 */
export type AcquisitionPrice = (tag: string) => number | null;

export interface ConversionStep {
  readonly edge: ConversionEdge;
  /** Units of `edge.from` consumed per one unit of the FINAL target, not of `edge.to`. */
  readonly inputUnits: number;
  /** Cost of one unit of `edge.to` once this step is paid for. */
  readonly unitCostAfter: number;
}

export type ConversionFlag =
  /** Some edge on the chosen path has `verified: false`. */
  | "unverified-edge"
  /** The path charges a step cost, and no step cost has been confirmed in-game yet. */
  | "unverified-step-cost"
  /** Long chain: ratio error compounds multiplicatively, so depth is its own risk. */
  | "deep-chain";

export interface ConversionPlan {
  readonly targetTag: string;
  /** Where money is actually spent. Equals `targetTag` when buying outright wins. */
  readonly entryTag: string;
  /** Units of `entryTag` per one unit of `targetTag`. 64 for Sharpness 1 -> 7. */
  readonly entryUnits: number;
  /** Cost of one unit of `targetTag` via this plan, including every step cost. */
  readonly unitCost: number;
  /** Empty when buying the target directly is the cheapest route. */
  readonly steps: readonly ConversionStep[];
  /** Market price of the target itself, for comparison. Null if unpriced. */
  readonly directPrice: number | null;
  /** True when crafting genuinely beats buying. Often false, and that is a real answer. */
  readonly beatsDirect: boolean;
  readonly flags: readonly ConversionFlag[];
}

export type ConvertError =
  /** The tag appears nowhere: no price, and nothing produces it. */
  | "unknown-target"
  /** Known, but no priced route reaches it. */
  | "no-acquisition-path"
  | "invalid-edge";

export interface ConvertOptions {
  /** Guard against pathological graphs. Paths longer than this are not considered. */
  readonly maxDepth?: number;
  /** Step count beyond which "deep-chain" is raised. */
  readonly deepChainThreshold?: number;
}

/**
 * Sized against the real catalogue, not guessed. Enchant families run deeper than the
 * familiar Sharpness 1-7: eleven families span levels 1-10 (nine merges), and
 * ENCHANTMENT_FEATHER_FALLING_ lists levels up to 20. A depth cap of 8 — the first value
 * written here — would have silently returned "no-acquisition-path" for every 1-10 family
 * rather than failing loudly, which is the worst way for a limit to be wrong.
 *
 * Note this guard is a heuristic, not an exact bound: `depth` records the length of the
 * cheapest known route to a node, so a cheap-but-long route can crowd out a
 * dearer-but-shorter one near the limit. Harmless while the cap sits far above the
 * deepest real chain; worth revisiting if it is ever tightened.
 */
const DEFAULT_MAX_DEPTH = 24;

/**
 * Six merges (Sharpness 1 -> 7) is an ordinary craft, so flagging it would make the flag
 * noise. This fires on the genuinely deep chains — the 1 -> 10 families — where a wrong
 * ratio compounds through nine multiplications.
 */
const DEFAULT_DEEP_CHAIN_THRESHOLD = 6;

function isValidEdge(e: ConversionEdge): boolean {
  return (
    e.from.trim() !== "" &&
    e.to.trim() !== "" &&
    e.from !== e.to &&
    Number.isInteger(e.inputPerOutput) &&
    e.inputPerOutput >= 1 &&
    Number.isFinite(e.stepCost) &&
    e.stepCost >= 0
  );
}

/**
 * Cheapest route to one unit of `targetTag`.
 *
 *   cost(t) = min( price(t), min over edges e into t of ( e.inputPerOutput * cost(e.from) + e.stepCost ) )
 *
 * Multiplicative, but Dijkstra-safe: `inputPerOutput >= 1` and prices are positive, so
 * deriving a tag through an edge can never cost LESS than its input already did. That is
 * exactly Dijkstra's non-decreasing condition, so a settled node never needs revisiting
 * and a cycle in the recipe graph cannot spiral downwards. Worth stating because recipe
 * graphs are not guaranteed acyclic, which would otherwise force Bellman-Ford.
 *
 * Buying the target outright is not a special case: it is simply `dist[target]` seeded
 * with the market price and left to compete with every derived route.
 *
 * Node counts here are in the hundreds (43 recipes plus ~286 book level-endpoints), so
 * settling by linear scan is chosen over a binary heap for readability. If the graph ever
 * grows by an order of magnitude, that is the line to change.
 */
export function cheapestPath(
  targetTag: string,
  edges: readonly ConversionEdge[],
  priceOf: AcquisitionPrice,
  options: ConvertOptions = {},
): Result<ConversionPlan, ConvertError> {
  for (const e of edges) {
    if (!isValidEdge(e)) return err("invalid-edge");
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const deepChainThreshold = options.deepChainThreshold ?? DEFAULT_DEEP_CHAIN_THRESHOLD;

  const outgoing = new Map<string, ConversionEdge[]>();
  const nodes = new Set<string>([targetTag]);
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    const list = outgoing.get(e.from);
    if (list) list.push(e);
    else outgoing.set(e.from, [e]);
  }

  const directPrice = priceOf(targetTag);
  const producesTarget = edges.some((e) => e.to === targetTag);
  if (directPrice === null && !producesTarget) return err("unknown-target");

  const dist = new Map<string, number>();
  const depth = new Map<string, number>();
  const cameFrom = new Map<string, ConversionEdge>();
  const settled = new Set<string>();

  for (const tag of nodes) {
    const price = priceOf(tag);
    if (price !== null && Number.isFinite(price) && price > 0) {
      dist.set(tag, price);
      depth.set(tag, 0);
    }
  }

  for (;;) {
    let current: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [tag, d] of dist) {
      if (!settled.has(tag) && d < best) {
        best = d;
        current = tag;
      }
    }
    if (current === null) break;
    settled.add(current);
    if (current === targetTag) break;

    const currentDepth = depth.get(current) ?? 0;
    if (currentDepth >= maxDepth) continue;

    for (const e of outgoing.get(current) ?? []) {
      if (settled.has(e.to)) continue;
      const candidate = e.inputPerOutput * best + e.stepCost;
      const known = dist.get(e.to);
      if (known === undefined || candidate < known) {
        dist.set(e.to, candidate);
        depth.set(e.to, currentDepth + 1);
        cameFrom.set(e.to, e);
      }
    }
  }

  const unitCost = dist.get(targetTag);
  if (unitCost === undefined) return err("no-acquisition-path");

  // Walk predecessors back to the entry tag, then reverse into forward order.
  const reversed: ConversionEdge[] = [];
  let cursor = targetTag;
  for (;;) {
    const edge = cameFrom.get(cursor);
    if (!edge) break;
    reversed.push(edge);
    cursor = edge.from;
    if (reversed.length > maxDepth) break; // defensive; cycles cannot reach here
  }
  const path = reversed.reverse();

  /**
   * Units consumed at each step, expressed per one unit of the FINAL target. For
   * A -(r1)-> B -(r2)-> C, one C needs r2 of B and r1*r2 of A: each step's figure is the
   * product of its own ratio and every ratio downstream. Accumulated in one backward pass
   * rather than recomputing the suffix product per step.
   */
  const backward: ConversionStep[] = [];
  let units = 1;
  for (let i = path.length - 1; i >= 0; i--) {
    const edge = path[i];
    if (!edge) continue;
    units *= edge.inputPerOutput;
    backward.push({
      edge,
      inputUnits: units,
      unitCostAfter: dist.get(edge.to) ?? Number.NaN,
    });
  }
  const steps = backward.reverse();

  const first = steps[0];
  const entryTag = first ? first.edge.from : targetTag;
  const entryUnits = first ? first.inputUnits : 1;

  const flags: ConversionFlag[] = [];
  if (steps.some((s) => !s.edge.verified)) flags.push("unverified-edge");
  if (steps.some((s) => s.edge.stepCost > 0)) flags.push("unverified-step-cost");
  if (steps.length > deepChainThreshold) flags.push("deep-chain");

  return ok({
    targetTag,
    entryTag,
    entryUnits,
    unitCost,
    steps,
    directPrice,
    beatsDirect: directPrice !== null && unitCost < directPrice,
    flags,
  });
}
