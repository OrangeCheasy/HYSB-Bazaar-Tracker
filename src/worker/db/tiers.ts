/**
 * Tier A = recipe tags UNION top-N tags by sellMovingWeek (CLAUDE.md section 2).
 * Recomputed from scratch every ingest tick — a tag that starts trading gets promoted
 * automatically, a dead one falls out, and this must never require a migration.
 *
 * `recipeTags` must already be the union of every recipe row's base_tag AND ench_tag
 * (several recipes chain — a tier-2 craft's base_tag is another recipe's ench_tag — so
 * unioning base_tag alone silently drops real Tier A tags). The caller owns that union
 * since it comes straight out of a DB query; this function only does set logic.
 */
export function computeTierA(
  recipeTags: readonly string[],
  productsBySellMovingWeekDesc: readonly string[],
  topN: number,
): Set<string> {
  const tierA = new Set(recipeTags);
  for (const tag of productsBySellMovingWeekDesc.slice(0, topN)) {
    tierA.add(tag);
  }
  return tierA;
}
