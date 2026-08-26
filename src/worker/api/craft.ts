import { parseBookTag, type CraftRow } from "@core/index.js";
import { buildAnvilCraft } from "../anvilCraft.js";
import { selectRecipesByBaseTag } from "../db/recipes.js";
import type { Env } from "../index.js";
import { buildCraftAnalysis, parseScanQueryParams, toRecipe } from "../scan.js";
import { errorResponse, json } from "./index.js";

/**
 * GET /api/craft/:tag?tax=&capture=&tick=&sleepStart=&sleepEnd=&window=&capital=
 *
 * Full three-scenario breakdown. Always computed live: unlike `/api/scan`, this touches
 * one or a handful of recipes rather than the whole catalogue, so there is no default/KV
 * split to make.
 *
 * **Two kinds of tag reach this route, and they are keyed differently.**
 *
 * For compaction, `:tag` is the BASE material — usually one recipe, occasionally more
 * where a base chains into several enchanted products.
 *
 * For anvil, `:tag` is the TARGET rung: the book you would sell. That asymmetry is not
 * arbitrary. A merge chain is identified by what it produces, because every rung below the
 * top is an entry point into the same chain — so keying on a base rung would ask a question
 * with several right answers. It also fixes a real bug: the scan's anvil rows carry a
 * synthetic recipe whose ratio is the whole chain's `entryUnits` (Ultimate Wise 1 -> 5 as
 * ratio 16), and that recipe is in no table. Looking its base tag up here returned the
 * stored 2:1 edge instead and analysed THAT, so the scan said 1.91M/day and this page said
 * 345k/day for what a user believed was the same trade.
 */
export async function handleCraft(tag: string, url: URL, env: Env): Promise<Response> {
  // Validate before touching D1: a malformed query string is answerable without a read,
  // and a bad `tax=` on a tag that happens not to exist should say so, not 404.
  const parsed = parseScanQueryParams(url);
  if (!parsed.ok) return errorResponse(parsed.error, 400);
  const { params, capitalAvailable } = parsed.value;

  const now = Math.floor(Date.now() / 1000);

  // A book tag is unambiguous, so it decides the route before any recipe lookup.
  if (parseBookTag(tag) !== null) {
    const anvil = await buildAnvilCraft(env.DB, tag, params, now, capitalAvailable);
    if (anvil === null) {
      return errorResponse(`no merge chain produces '${tag}'`, 404);
    }
    // A row with no analysis is returned as a 200 rather than a 422, unlike the compaction
    // path below. `buying-beats-merging` is a real answer, not a failure, and the plan and
    // ladder attached to it are exactly what makes that answer readable — a 422 would
    // throw away the comparison that justifies it.
    return json(
      [anvil.row] satisfies CraftRow[],
      { generatedAt: anvil.dataTo, staleAfter: anvil.dataTo + 3600, source: "d1" },
      200,
      "public, max-age=120",
    );
  }

  const recipeRows = await selectRecipesByBaseTag(env.DB, tag);
  if (recipeRows.length === 0) {
    return errorResponse(`no recipe with base tag '${tag}'`, 404);
  }

  const results = await Promise.all(
    recipeRows.map(async (row) => {
      const recipe = toRecipe(row);
      const built = await buildCraftAnalysis(env.DB, recipe, params, now, capitalAvailable);
      return { recipe, kind: row.kind, ...built };
    }),
  );

  const anySucceeded = results.some((r) => r.analysis !== undefined);
  if (!anySucceeded) {
    // Every recipe on this base tag failed the same way (most commonly "no data yet"
    // for a brand-new tag) — surface the reason rather than an empty 200.
    return errorResponse(results[0]?.error ?? "could not analyze craft", 422);
  }

  // Same "stalest input wins" honesty rule as runScan — only over rows that succeeded.
  let dataTo = now;
  for (const r of results) {
    if (r.analysis !== undefined && r.dataTo < dataTo) dataTo = r.dataTo;
  }

  const payload: CraftRow[] = results.map(({ recipe, analysis, error, kind }) => ({
    recipe,
    analysis,
    error,
    kind,
  }));
  return json(
    payload,
    { generatedAt: dataTo, staleAfter: dataTo + 3600, source: "d1" },
    200,
    // This is the page a user is actively deciding on right now, so it stays closer to
    // real freshness than the general item page — but `hourly` still only changes
    // hourly, so anything shorter than a couple of minutes would not serve fresher
    // numbers, only hit D1 harder for identical answers.
    "public, max-age=120",
  );
}
