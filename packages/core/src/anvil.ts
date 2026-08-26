import type { ConversionEdge } from "./convert.js";

/**
 * Enchanted books and anvil merging (CLAUDE.md section 8).
 *
 * Two books of the SAME enchant at the SAME level combine into one book of the next level
 * up. Reaching level M from level L therefore costs 2^(M-L) books — Sharpness 1 -> 7 is
 * 2^6 = 64, not 6. That exponent is the single most re-derivable-wrong fact here, and it
 * is stated once, in `booksRequired`.
 *
 * Nothing in this module knows the name of a single enchant. Families and their level
 * ranges are derived from whatever tag list is passed in, so a new enchant appearing on
 * the bazaar works with no code change — the same discipline CLAUDE.md section 2 applies
 * to tier assignment.
 *
 * Note this module does NOT compute costs. It emits edges; `convert.ts` prices them and
 * picks the entry level. Keeping the arithmetic in one place is ADR-023's whole point.
 */

/** Two books in, one out. The only ratio an anvil merge ever has. */
export const ANVIL_INPUT_PER_OUTPUT = 2;

/** `ENCHANTMENT_{NAME}_{LEVEL}`. The name may itself contain underscores
 *  (`ENCHANTMENT_ULTIMATE_WISE_3`), so the level is the trailing digit group and the
 *  family is everything before it. */
const BOOK_TAG = /^(ENCHANTMENT_.+)_(\d+)$/;

export interface BookTag {
  readonly tag: string;
  /** Includes the `ENCHANTMENT_` prefix, e.g. `ENCHANTMENT_ULTIMATE_WISE`. */
  readonly family: string;
  readonly level: number;
}

export interface EnchantFamily {
  readonly family: string;
  /** Ascending, de-duplicated, exactly the levels present in the input. */
  readonly levels: readonly number[];
  readonly minLevel: number;
  readonly maxLevel: number;
  /** True when `levels` covers min..max with no holes. */
  readonly contiguous: boolean;
}

export interface AnvilOptions {
  /**
   * Coins per merge performed. UNVERIFIED — CLAUDE.md section 8 flags the anvil fee as
   * something to confirm in-game, not a constant to hardcode. Defaults to zero so it
   * stays inert, and `convert.ts` raises `unverified-step-cost` on any path that pays it.
   */
  readonly stepCost?: number;
}

/** Parse a book tag, or null if it is not one. */
export function parseBookTag(tag: string): BookTag | null {
  const m = BOOK_TAG.exec(tag);
  if (!m) return null;
  const family = m[1];
  const raw = m[2];
  if (family === undefined || raw === undefined) return null;
  const level = Number.parseInt(raw, 10);
  if (!Number.isInteger(level) || level < 0) return null;
  return { tag, family, level };
}

/**
 * Merge chains start at level 1.
 *
 * The bazaar lists three level-0 books: ENCHANTMENT_CURSE_OF_VANISHING_0,
 * ENCHANTMENT_WITHER_HUNTER_0, and ENCHANTMENT_ULTIMATE_ONE_FOR_ALL_0 (whose family is
 * levels [0, 1]). They are parsed and kept visible in `levels` — silently dropping real
 * product tags hides data — but they do not produce merge edges.
 *
 * The asymmetry is deliberate. Emitting a 0 -> 1 edge asserts that two "level 0" books
 * combine into a level 1, which nothing has confirmed; a wrong edge produces a confident
 * wrong price, which is the failure CLAUDE.md section 8 exists to prevent. Omitting it
 * costs at most one speculative opportunity on one enchant. If someone confirms the merge
 * in-game, lower this to 0 and the edge appears with no other change.
 */
export const MIN_MERGE_LEVEL = 1;

/** Rebuild the tag for one rung. Inverse of `parseBookTag`. */
export function bookTagFor(family: string, level: number): string {
  return `${family}_${level}`;
}

/**
 * Books required to produce ONE book at `toLevel`, starting from `fromLevel`.
 *
 * This is the 2^(M-L) rule and the reason a "6 steps means 6 books" intuition is wrong by
 * a factor of ten. Returns null for a non-ascending or non-integer span rather than a
 * misleading number.
 */
export function booksRequired(fromLevel: number, toLevel: number): number | null {
  if (!Number.isInteger(fromLevel) || !Number.isInteger(toLevel)) return null;
  if (fromLevel < 1 || toLevel <= fromLevel) return null;
  return ANVIL_INPUT_PER_OUTPUT ** (toLevel - fromLevel);
}

/**
 * Group a product tag list into enchant families.
 *
 * Derived, never hardcoded. Non-book tags are ignored, so this can be handed the entire
 * bazaar product list unfiltered.
 */
export function deriveFamilies(tags: readonly string[]): readonly EnchantFamily[] {
  const byFamily = new Map<string, Set<number>>();
  for (const tag of tags) {
    const parsed = parseBookTag(tag);
    if (!parsed) continue;
    const levels = byFamily.get(parsed.family);
    if (levels) levels.add(parsed.level);
    else byFamily.set(parsed.family, new Set([parsed.level]));
  }

  const families: EnchantFamily[] = [];
  for (const [family, levelSet] of byFamily) {
    const levels = [...levelSet].sort((a, b) => a - b);
    const minLevel = levels[0];
    const maxLevel = levels[levels.length - 1];
    if (minLevel === undefined || maxLevel === undefined) continue;
    families.push({
      family,
      levels,
      minLevel,
      maxLevel,
      contiguous: levels.length === maxLevel - minLevel + 1,
    });
  }
  families.sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  return families;
}

/**
 * One edge per ADJACENT level pair.
 *
 * Adjacency is what keeps this honest on a gapped family. `ENCHANTMENT_FEATHER_FALLING_`
 * lists levels 1-10 and then 20; emitting a 10 -> 20 edge would claim a single merge can
 * jump ten levels, which would price 2^10 books as though it were 2. Requiring
 * `next === level + 1` drops that jump and keeps the 1-10 chain, with no special case.
 *
 * Every edge is `verified: false`. Tag existence is checked here; the ratio is not
 * checkable by name matching (CLAUDE.md section 8), and an anvil recipe is exactly as
 * unverified as any other guess until someone confirms it in-game.
 */
export function anvilEdges(
  families: readonly EnchantFamily[],
  options: AnvilOptions = {},
): readonly ConversionEdge[] {
  const stepCost = options.stepCost ?? 0;
  const edges: ConversionEdge[] = [];
  for (const fam of families) {
    for (let i = 0; i < fam.levels.length - 1; i++) {
      const level = fam.levels[i];
      const next = fam.levels[i + 1];
      if (level === undefined || next === undefined) continue;
      if (level < MIN_MERGE_LEVEL) continue; // see MIN_MERGE_LEVEL
      if (next !== level + 1) continue; // not a single merge — see the gap note above
      edges.push({
        from: bookTagFor(fam.family, level),
        to: bookTagFor(fam.family, next),
        inputPerOutput: ANVIL_INPUT_PER_OUTPUT,
        stepCost,
        kind: "anvil",
        verified: false,
        recipeId: null,
      });
    }
  }
  return edges;
}

/**
 * The tags worth sampling at five-minute resolution: the lowest and highest rung of each
 * family (CLAUDE.md section 2).
 *
 * Measured against a live hour, these two rungs are 91% of book coin turnover across 286
 * of 774 tags. Ranking books by UNIT volume instead would drop the max-level rung — it is
 * 4.6% of units but 21% of coins, because those books average 20M each.
 */
export function levelEndpointTags(families: readonly EnchantFamily[]): readonly string[] {
  const tags: string[] = [];
  for (const fam of families) {
    const mergeable = fam.levels.filter((l) => l >= MIN_MERGE_LEVEL);
    const lo = mergeable[0];
    const hi = mergeable[mergeable.length - 1];
    if (lo === undefined || hi === undefined) continue;
    tags.push(bookTagFor(fam.family, lo));
    if (hi !== lo) tags.push(bookTagFor(fam.family, hi));
  }
  return tags;
}

/** Families with at least one possible merge — i.e. two adjacent rungs at or above
 *  MIN_MERGE_LEVEL. Single-rung families cannot be crafted into anything and are not
 *  opportunities, so they are not scan rows either. */
export function mergeableFamilies(
  families: readonly EnchantFamily[],
): readonly EnchantFamily[] {
  return families.filter((f) => {
    const levels = f.levels.filter((l) => l >= MIN_MERGE_LEVEL);
    return levels.some((l, i) => i > 0 && l === (levels[i - 1] ?? -1) + 1);
  });
}

/**
 * Above this, a merge is treated as impossible rather than lucrative.
 *
 * The implied merge ratio is `price(level N+1) / (2 * price(level N))` — what the output
 * is worth against what the inputs cost. A real merge lands near 1: you are converting
 * two books into one worth roughly the same, minus the market's opinion. Measured across
 * the 144 anvil edges with prices on both rungs, the distribution is sharply bimodal:
 *
 *   <0.5   19        1.5-3    10
 *   0.5-1  50        3-10      5
 *   1-1.5  48        10-100    5
 *                    >100      7
 *
 * 127 of 144 sit under 1.5. The tail is not a set of extraordinary trades — it is books
 * whose top rung cannot be produced by merging at all, because it comes from somewhere
 * else in the game (a minigame reward, a specific drop). ENCHANTMENT_LOOTING_5 is the
 * clearest case: Looting IV asks 50,000 and Looting V bids 154,137,188, an implied ratio
 * near 1,500. Two Looting IV books do not make a Looting V; the game does not offer that
 * conversion, so the "1,509% margin" is a trade nobody can execute.
 *
 * 3 aligns with CLAUDE.md section 8's existing rule of thumb — a 200% margin means the
 * recipe is wrong, the item is dead, or someone is walling it — so this is that heuristic
 * applied to a chain rather than a new invention. Tunable, because the 3-10 band is
 * genuinely ambiguous and worth revisiting once merges start being verified by hand.
 */
export const DEFAULT_MAX_IMPLIED_MERGE_RATIO = 3;

export interface GatedEdge {
  readonly edge: ConversionEdge;
  /** `price(to) / (inputPerOutput * price(from))`. */
  readonly impliedRatio: number;
}

export interface MergeGateResult {
  /** Edges the solver may route through. */
  readonly usable: readonly ConversionEdge[];
  /** Edges withheld as un-mergeable, kept so callers can say WHY a rung is unreachable
   *  instead of silently truncating the chain. */
  readonly gated: readonly GatedEdge[];
}

/**
 * Split merge edges into ones worth pricing and ones the market says are impossible.
 *
 * An edge whose price ratio cannot be computed — either rung unpriced, or a zero/negative
 * input price — is left USABLE rather than gated. Absence of evidence is not evidence of a
 * gate, and the solver already refuses to route through a rung it has no price for; gating
 * on missing data would quietly delete real chains whenever a thin rung skipped an hour.
 */
export function detectMergeGates(
  edges: readonly ConversionEdge[],
  priceOf: (tag: string) => number | null,
  maxImpliedRatio: number = DEFAULT_MAX_IMPLIED_MERGE_RATIO,
): MergeGateResult {
  const usable: ConversionEdge[] = [];
  const gated: GatedEdge[] = [];

  for (const edge of edges) {
    const from = priceOf(edge.from);
    const to = priceOf(edge.to);
    if (from === null || to === null || from <= 0 || edge.inputPerOutput <= 0) {
      usable.push(edge);
      continue;
    }
    const impliedRatio = to / (edge.inputPerOutput * from);
    if (impliedRatio > maxImpliedRatio) gated.push({ edge, impliedRatio });
    else usable.push(edge);
  }

  return { usable, gated };
}

/**
 * The highest level a merge chain may target.
 *
 * Anvil merging tops out at level 5 for most enchants. Levels 6 and 7 exist on the bazaar
 * — 20 families list a rung 6 and 16 list a rung 7 — but they are not produced by combining
 * two level-5 books; they come from elsewhere in the game. Targeting them prices a craft
 * nobody can perform, which is the same failure ADR-025's gate detection catches from the
 * price side. This catches it structurally, so a family whose upper rungs happen to be
 * cheap enough to look mergeable is still not routed through them.
 *
 * The exception is the families that run all the way to 10. Those genuinely merge the whole
 * way, so their chains are left alone.
 *
 * Measured across the live catalogue (155 families): 4 top out at 2, 10 at 3, 4 at 4, 76 at
 * 5, 20 at 6, 16 at 7, 1 at 9, and 11 at 10. So this rule re-targets 36 families and leaves
 * 119 untouched.
 *
 * **The level-9 family is the open question.** `CULTIVATING` lists rungs to 9 and no 10, so
 * by the letter of this rule it is capped at 5. If Cultivating really does merge to 10 and
 * the top rung simply is not listed, the cap is wrong for it — one family, flagged here
 * rather than silently decided.
 */
export const ANVIL_SOFT_CAP_LEVEL = 5;
export const ANVIL_FULL_CHAIN_LEVEL = 10;

export function mergeTargetLevel(levels: readonly number[]): number | undefined {
  const usable = levels.filter((l) => l >= MIN_MERGE_LEVEL).sort((a, b) => a - b);
  const top = usable[usable.length - 1];
  if (top === undefined) return undefined;

  // A family that reaches 10 merges all the way; anything else stops at 5.
  const cap = usable.includes(ANVIL_FULL_CHAIN_LEVEL)
    ? ANVIL_FULL_CHAIN_LEVEL
    : ANVIL_SOFT_CAP_LEVEL;
  if (top <= cap) return top;

  // The highest rung at or below the cap that the family actually lists — not the cap
  // itself, since a family may skip levels.
  const reachable = usable.filter((l) => l <= cap);
  return reachable[reachable.length - 1];
}
