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
