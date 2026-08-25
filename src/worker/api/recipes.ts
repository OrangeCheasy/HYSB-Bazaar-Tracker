import { selectAllRecipes } from "../db/recipes.js";
import type { Env } from "../index.js";
import { toRecipe } from "../scan.js";
import { json } from "./index.js";

/**
 * GET /api/recipes — the full recipe list, `verified` flags included (CLAUDE.md §8:
 * an unverified ratio must be visually marked in the UI, so the client needs the flag).
 *
 * Recipes carry no timestamp column (0001_initial.sql) — they are seeded once by
 * migration 0003 and otherwise static, not a time series a cron refreshes. So unlike
 * every other route, `generatedAt: now` here is honest rather than a lie of
 * omission: there is no better "as of" time to report, and the long staleAfter says
 * plainly that this is expected to hold for a while, not that it was just computed
 * from fresh data.
 */
export async function handleRecipes(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await selectAllRecipes(env.DB);
  const recipes = rows.map(toRecipe);

  return json(
    recipes,
    { generatedAt: now, staleAfter: now + 86_400, source: "d1" },
    200,
    // Recipes only change via a migration + deploy, effectively never at request time.
    // An hour is already conservative against that; it exists mainly so a corrected
    // ratio does not take a full day to reach a returning visitor.
    "public, max-age=3600",
  );
}
