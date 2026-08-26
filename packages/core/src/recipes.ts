import { err, ok, type Result } from "./result.js";

/**
 * Recipes: base tag, enchanted tag, and the ratio between them.
 *
 * The ratio is the dangerous field. Tag existence can be validated automatically against
 * the product list; ratios cannot, because name matching cannot see a crafting grid.
 * Every recipe therefore carries a `verified` flag, and unverified ones are visually
 * marked in the UI (CLAUDE.md section 8).
 */

export const DEFAULT_RATIO = 160;

/**
 * Documented departures from 160:1. Each of these is a wrong number waiting to happen if
 * someone assumes the default.
 */
export const RATIO_EXCEPTIONS: Readonly<Record<string, number>> = {
  ENDER_PEARL: 20,
  EGG: 144,
  HARD_STONE: 576,
};

/** Sanity bounds on a ratio. Wide on purpose — this only catches nonsense. */
const MIN_RATIO = 1;
const MAX_RATIO = 10_000;

/**
 * Which craft type a recipe describes. Compaction is a fixed n:1 ratio; anvil is a 2:1
 * merge edge in an enchant family's level chain (CLAUDE.md section 8). Both live in the
 * same `recipes` table and both rank in the same scan, so the discriminator is domain
 * data rather than a storage detail — it belongs here, not in the D1 layer.
 */
export type RecipeKind = "compact" | "anvil";

export interface Recipe {
  /** Null until persisted — recipes are seeded by hand before they get an id. */
  readonly id: number | null;
  readonly baseTag: string;
  readonly enchTag: string;
  readonly ratio: number;
  readonly verified: boolean;
  readonly note: string | null;
  /** Collection level required to craft, where known. Surface it; do not pretend it away. */
  readonly collectionRequirement?: string;
}

export type RecipeIssue =
  | { readonly kind: "empty-tag"; readonly field: "baseTag" | "enchTag" }
  | { readonly kind: "non-integer-ratio"; readonly ratio: number }
  | { readonly kind: "ratio-out-of-range"; readonly ratio: number }
  | { readonly kind: "self-referential" }
  | {
      readonly kind: "ratio-differs-from-convention";
      readonly expected: number;
      readonly actual: number;
    };

export function isEnchantedTag(tag: string): boolean {
  return tag.startsWith("ENCHANTED_");
}

/** The conventional ratio for a base tag, honouring the exception table. */
export function expectedRatio(baseTag: string): number {
  return RATIO_EXCEPTIONS[baseTag] ?? DEFAULT_RATIO;
}

/** The base-material cost of one crafted unit — the price at which the craft breaks even. */
export function parityPrice(basePrice: number, recipe: Recipe): number {
  return basePrice * recipe.ratio;
}

/**
 * Validate a recipe, reporting every problem at once rather than stopping at the first.
 *
 * A VERIFIED recipe is allowed to disagree with the 160 convention — that is precisely
 * what verification is for. An unverified one that disagrees is almost certainly a bad
 * guess from name matching, so it does not pass.
 */
export function validateRecipe(recipe: Recipe): Result<Recipe, readonly RecipeIssue[]> {
  const issues: RecipeIssue[] = [];

  const baseTag = recipe.baseTag.trim();
  const enchTag = recipe.enchTag.trim();

  if (baseTag === "") issues.push({ kind: "empty-tag", field: "baseTag" });
  if (enchTag === "") issues.push({ kind: "empty-tag", field: "enchTag" });
  if (baseTag !== "" && baseTag === enchTag) issues.push({ kind: "self-referential" });

  if (!Number.isInteger(recipe.ratio)) {
    issues.push({ kind: "non-integer-ratio", ratio: recipe.ratio });
  } else if (recipe.ratio < MIN_RATIO || recipe.ratio > MAX_RATIO) {
    issues.push({ kind: "ratio-out-of-range", ratio: recipe.ratio });
  } else if (!recipe.verified) {
    const expected = expectedRatio(baseTag);
    if (recipe.ratio !== expected) {
      issues.push({
        kind: "ratio-differs-from-convention",
        expected,
        actual: recipe.ratio,
      });
    }
  }

  if (issues.length > 0) return err(issues);
  return ok({ ...recipe, baseTag, enchTag });
}

/**
 * Candidate compaction recipes, derived from the live product list.
 *
 * The seeded list in migration 0003 covered 43 crafts. Measured against a live payload it
 * was missing **49** more that the bazaar plainly lists — leather, feather, blaze rod, the
 * mushrooms, most of the newer materials — so the scan was searching about half the board.
 * A hand-written list cannot keep up with a game that adds items, which is the same
 * argument migration 0008 and ADR-024 already made for anvil edges: derive it, do not
 * freeze it.
 *
 * **What this validates and what it does not.** Tag existence is checkable automatically
 * and is checked here: a pair is emitted only when BOTH tags are really listed. The
 * *ratio* is not checkable — CLAUDE.md §8 is explicit that name matching cannot see a
 * crafting grid — so every derived recipe carries the default ratio, or a documented
 * exception, and `verified: false`. That flag is the whole safety net, and the UI marks it
 * on every row.
 *
 * Two structural patterns, both name-derivable:
 *
 *   - `X` -> `ENCHANTED_X` — the ordinary 160:1 compaction.
 *   - `ENCHANTED_Y` -> `ENCHANTED_Y_...` — a SECOND-TIER craft, which consumes the
 *     enchanted form rather than the raw one, detected by another enchanted product's tag
 *     being a proper prefix of this one at an underscore boundary.
 *
 * The second rule matters more than it looks. `ENCHANTED_SUGAR_CANE` name-matches
 * `SUGAR_CANE` perfectly, and taking that match produces a plausible-looking 160:1 recipe
 * for what is really sugar cane -> enchanted sugar -> enchanted sugar cane — two steps, so
 * the derived one-step version understates the cost by a factor of 160. Migration 0006
 * exists because that exact chain was got wrong once already. Preferring the longest
 * enchanted prefix catches it, and catches `ENCHANTED_COAL_BLOCK` with the same rule
 * rather than a `_BLOCK` special case.
 *
 * Renamed pairs are deliberately NOT guessed. `ENCHANTED_CACTUS_GREEN`,
 * `ENCHANTED_SUGAR`, `ENCHANTED_FLINT` and friends have bases whose names do not contain
 * them, and inventing a mapping is exactly the kind of unverifiable assertion this module
 * exists to avoid. They stay hand-curated.
 */
export function deriveCompactionRecipes(productTags: readonly string[]): readonly Recipe[] {
  const tags = new Set(productTags);
  const recipes: Recipe[] = [];

  for (const tag of productTags) {
    if (!tag.startsWith("ENCHANTED_")) continue;
    // `ENCHANTMENT_*` is an enchanted BOOK — anvil territory, and a different craft type.
    // The prefixes differ by two letters and matching the wrong one would put 777 books
    // through the compaction model.
    if (tag.startsWith("ENCHANTMENT_")) continue;

    // Longest enchanted prefix wins: a tier-2 craft consumes the enchanted intermediate,
    // and that intermediate's tag is a prefix of this one.
    const intermediate = longestEnchantedPrefix(tag, tags);
    if (intermediate !== null) {
      recipes.push(makeDerived(intermediate, tag));
      continue;
    }

    const base = tag.slice("ENCHANTED_".length);
    if (base !== "" && tags.has(base)) recipes.push(makeDerived(base, tag));
  }

  return recipes.sort((a, b) =>
    a.baseTag === b.baseTag
      ? a.enchTag.localeCompare(b.enchTag)
      : a.baseTag.localeCompare(b.baseTag),
  );
}

/**
 * The longest other `ENCHANTED_*` product whose tag is a proper prefix of `tag` at an
 * underscore boundary, or null.
 *
 * The boundary check is what stops `ENCHANTED_GOLD` from claiming `ENCHANTED_GOLDEN_CARROT`
 * — a prefix by characters, not by name.
 */
function longestEnchantedPrefix(tag: string, tags: ReadonlySet<string>): string | null {
  let best: string | null = null;
  for (const candidate of tags) {
    if (candidate === tag) continue;
    if (!candidate.startsWith("ENCHANTED_")) continue;
    if (!tag.startsWith(candidate + "_")) continue;
    if (best === null || candidate.length > best.length) best = candidate;
  }
  return best;
}

function makeDerived(baseTag: string, enchTag: string): Recipe {
  return {
    id: null,
    baseTag,
    enchTag,
    // `expectedRatio` applies the documented exceptions (ender pearls 20, eggs 144, hard
    // stone 576) and otherwise the 160 default.
    ratio: expectedRatio(baseTag),
    // Never true. The ratio is a guess about a crafting grid nobody has looked at.
    verified: false,
    note: "derived from the product list; ratio unconfirmed",
  };
}
