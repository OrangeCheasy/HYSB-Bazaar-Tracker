import { parseBookTag } from "@core/index.js";

/**
 * Bazaar tags to something readable.
 *
 * The API returns raw tags — `ENCHANTMENT_ULTIMATE_WISE_5`, `ENCHANTED_SUGAR_CANE` — and
 * at 375px a raw tag is most of the row. This is display only: the raw tag stays available
 * on the row (as the link target and the `title`), because it is what you search the
 * bazaar for in game.
 *
 * Purely mechanical, deliberately. There is no product-name table in the database, and
 * inventing one would be a hand-maintained list going stale exactly like the hardcoded
 * enchant catalogue that migration 0008 exists to avoid.
 */

/** Words that should not be title-cased into something that reads wrong. */
const ACRONYMS: Readonly<Record<string, string>> = {
  TNT: "TNT",
};

function titleCaseWord(word: string): string {
  const upper = word.toUpperCase();
  const acronym = ACRONYMS[upper];
  if (acronym !== undefined) return acronym;
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * `ENCHANTMENT_ULTIMATE_WISE_5` → `Ultimate Wise 5`
 * `ENCHANTED_SUGAR_CANE` → `Enchanted Sugar Cane`
 * `COAL` → `Coal`
 *
 * Book tags go through core's `parseBookTag` rather than a second underscore-splitting
 * heuristic here — it already knows that the trailing number is a level and that the
 * prefix is `ENCHANTMENT_`, including the awkward cases (levels above 9, level 0).
 */
export function displayTag(tag: string): string {
  const book = parseBookTag(tag);
  if (book !== null) {
    // `family` carries the ENCHANTMENT_ prefix (see core's BookTag) — it is what makes the
    // family key unambiguous there, and it is noise here.
    const enchant = book.family
      .replace(/^ENCHANTMENT_/, "")
      .split("_")
      .map(titleCaseWord)
      .join(" ");
    return `${enchant} ${book.level}`;
  }
  return tag.split("_").map(titleCaseWord).join(" ");
}
