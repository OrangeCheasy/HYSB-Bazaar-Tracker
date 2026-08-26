import {
  bookTagFor,
  cheapestPath,
  detectMergeGates,
  parseBookTag,
  type ConversionEdge,
  type CraftRow,
  type EntryRung,
} from "@core/index.js";
import { selectRecipesByKind } from "./db/recipes.js";
import {
  anvilRecipeShell,
  buildCraftAnalysis,
  fetchBookAskPrices,
  type ScanParams,
} from "./scan.js";

/**
 * The detail view of a single merge chain, for `/api/craft/:tag`.
 *
 * This exists because the scan and the detail page were describing DIFFERENT TRADES. A
 * scan row for an anvil merge carries a synthetic recipe — `anvilRecipeShell`, where
 * `ratio` is the solver's `entryUnits`, so Ultimate Wise 1 -> 5 arrives as ratio 16 — and
 * that recipe exists nowhere in the database. What IS stored is the 2:1 edges. So looking
 * the tag up with `selectRecipesByBaseTag` returned the single rung-to-next-rung merge and
 * analysed that instead: the scan said 1 -> 5 at ratio 16 for 1.91M/day, the detail page
 * said 1 -> 2 at ratio 2 for 345k/day. Not an error page — a confidently wrong one.
 *
 * So the chain is re-solved here the same way the scan solves it, from the same edges with
 * the same gate detection, and the answer carries the plan and the entry ladder with it.
 */

/** Keyed on the TARGET rung — what you sell, and what identifies the family's chain. An
 *  entry rung does not identify a chain, because every rung below the top is one. */
export async function buildAnvilCraft(
  db: Pick<D1Database, "prepare">,
  targetTag: string,
  params: ScanParams,
  now: number,
  capitalAvailable?: number,
): Promise<{ readonly row: CraftRow; readonly dataTo: number } | null> {
  const parsedTarget = parseBookTag(targetTag);
  if (parsedTarget === null) return null;

  const anvilRecipes = await selectRecipesByKind(db, "anvil");
  if (anvilRecipes.length === 0) return null;

  const edges: ConversionEdge[] = anvilRecipes.map((r) => ({
    from: r.base_tag,
    to: r.ench_tag,
    inputPerOutput: r.ratio,
    // Zero until the anvil fee is confirmed in-game (CLAUDE.md §8). A wrong fee is a wrong
    // margin on every book in the catalogue.
    stepCost: 0,
    kind: "anvil" as const,
    verified: r.verified !== 0,
    recipeId: r.id,
  }));

  const prices = await fetchBookAskPrices(db);
  const priceOf = (tag: string): number | null => prices.get(tag) ?? null;

  // The same withholding the scan applies: a rung the market says cannot be merged into is
  // one the game hands out elsewhere, so routing through it prices a trade nobody can make.
  const { usable: mergeableEdges, gated } = detectMergeGates(edges, priceOf);
  const gatedFrom = new Set(gated.map((g) => g.edge.from));

  const solved = cheapestPath(targetTag, mergeableEdges, priceOf);
  if (!solved.ok) {
    return {
      row: {
        recipe: anvilRecipeShell(targetTag, targetTag, 1),
        error: solved.error,
        kind: "anvil",
      },
      dataTo: now,
    };
  }

  const plan = solved.value;
  const recipe = anvilRecipeShell(plan.entryTag, targetTag, plan.entryUnits);
  const built =
    plan.steps.length === 0
      ? // Buying the finished book beats every merge route. A real answer, and one the
        // detail page should say out loud rather than analysing a craft that nobody would
        // do — but there is no craft to analyse, so there are no economics to report.
        { analysis: undefined, error: "buying-beats-merging", dataTo: now }
      : await buildCraftAnalysis(db, recipe, params, now, capitalAvailable);

  return {
    row: {
      recipe,
      analysis: built.analysis,
      error: built.error,
      kind: "anvil",
      plan,
      ladder: buildLadder(
        parsedTarget.family,
        parsedTarget.level,
        mergeableEdges,
        priceOf,
        plan.entryTag,
        gatedFrom,
      ),
    },
    dataTo: built.dataTo,
  };
}

/**
 * Every rung below the target, priced as an entry point.
 *
 * CLAUDE.md §8 states the cost as `2^(M-L) x price(L)`, and that is right whenever the
 * chain is adjacent rungs of ratio 2. It is NOT right in general, and the exceptions are
 * real: eleven families span levels 1-10, and `FEATHER_FALLING` lists 1-10 then jumps to
 * 20, so `2^(20-10)` would claim 1,024 books for what is one merge — or none, if no edge
 * joins those rungs at all.
 *
 * So the multiplier is accumulated along the EDGES, exactly as `cheapestPath` does. That
 * also means a confirmed anvil fee, or any non-2 ratio, needs no change here.
 *
 * A rung with no route to the target is omitted rather than priced: it is not an entry
 * point, and listing it with a cost would invite someone to buy books that cannot become
 * the thing they want.
 */
function buildLadder(
  family: string,
  targetLevel: number,
  edges: readonly ConversionEdge[],
  priceOf: (tag: string) => number | null,
  chosenTag: string,
  gatedFrom: ReadonlySet<string>,
): readonly EntryRung[] {
  // from-tag -> the edge leaving it. A rung has at most one merge upward.
  const upward = new Map<string, ConversionEdge>();
  for (const edge of edges) {
    const parsed = parseBookTag(edge.from);
    if (parsed?.family === family) upward.set(edge.from, edge);
  }

  const targetTag = bookTagFor(family, targetLevel);
  const rungs: EntryRung[] = [];

  for (const [tag] of upward) {
    const parsed = parseBookTag(tag);
    if (!parsed || parsed.level >= targetLevel) continue;

    // Walk up to the target, multiplying each edge's ratio. Bounded by the map size so a
    // cyclic edge set cannot spin here.
    let unitsRequired = 1;
    let cursor = tag;
    let reached = false;
    for (let step = 0; step < upward.size + 1; step++) {
      const edge = upward.get(cursor);
      if (edge === undefined) break;
      unitsRequired *= edge.inputPerOutput;
      cursor = edge.to;
      if (cursor === targetTag) {
        reached = true;
        break;
      }
    }
    if (!reached) continue;

    const price = priceOf(tag);
    rungs.push({
      tag,
      level: parsed.level,
      price,
      unitsRequired,
      totalCost: price === null ? null : price * unitsRequired,
      chosen: tag === chosenTag,
      ...(gatedFrom.has(tag) ? { gatedAbove: true } : {}),
    });
  }

  return rungs.sort((a, b) => a.level - b.level);
}
