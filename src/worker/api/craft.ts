import { selectRecipesByBaseTag } from "../db/recipes.js";
import type { Env } from "../index.js";
import { buildCraftAnalysis, parseScanQueryParams, toRecipe } from "../scan.js";
import { errorResponse, json } from "./index.js";

/**
 * GET /api/craft/:baseTag?tax=&capture=&tick=&sleepStart=&sleepEnd=&window=&capital=
 *
 * Full three-scenario breakdown for every recipe keyed on this base tag — usually one,
 * occasionally more (a base material chaining into more than one enchanted product).
 * Always computed live: unlike `/api/scan`, this touches one or a handful of recipes,
 * not the whole catalog, so there is no default/KV split to make.
 */
export async function handleCraft(baseTag: string, url: URL, env: Env): Promise<Response> {
  const recipeRows = await selectRecipesByBaseTag(env.DB, baseTag);
  if (recipeRows.length === 0) {
    return errorResponse(`no recipe with base tag '${baseTag}'`, 404);
  }

  const now = Math.floor(Date.now() / 1000);
  const { params, capitalAvailable } = parseScanQueryParams(url);

  const results = await Promise.all(
    recipeRows.map(async (row) => {
      const recipe = toRecipe(row);
      const built = await buildCraftAnalysis(env.DB, recipe, params, now, capitalAvailable);
      return { recipe, ...built };
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

  return json(
    results.map(({ recipe, analysis, error }) => ({ recipe, analysis, error })),
    { generatedAt: dataTo, staleAfter: dataTo + 3600, source: "d1" },
    200,
    // This is the page a user is actively deciding on right now, so it stays closer to
    // real freshness than the general item page — but `hourly` still only changes
    // hourly, so anything shorter than a couple of minutes would not serve fresher
    // numbers, only hit D1 harder for identical answers.
    "public, max-age=120",
  );
}
