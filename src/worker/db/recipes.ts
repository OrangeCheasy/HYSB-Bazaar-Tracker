/** Read-side recipe queries for the API layer. Writing recipes happens only via
 *  migration 0003, never at runtime — see CLAUDE.md §5, "migrations forward-only". */
export interface RecipeRow {
  readonly id: number;
  readonly base_tag: string;
  readonly ench_tag: string;
  readonly ratio: number;
  readonly verified: number;
  readonly note: string | null;
}

export async function selectAllRecipes(
  db: Pick<D1Database, "prepare">,
): Promise<RecipeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, base_tag, ench_tag, ratio, verified, note
       FROM recipes ORDER BY base_tag, ench_tag`,
    )
    .all<RecipeRow>();
  return results;
}

export async function selectRecipesByBaseTag(
  db: Pick<D1Database, "prepare">,
  baseTag: string,
): Promise<RecipeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, base_tag, ench_tag, ratio, verified, note
       FROM recipes WHERE base_tag = ?1 ORDER BY ench_tag`,
    )
    .bind(baseTag)
    .all<RecipeRow>();
  return results;
}
