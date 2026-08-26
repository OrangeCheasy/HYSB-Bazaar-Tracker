import { chunkByParamCount } from "./chunk.js";

/**
 * Recipe queries.
 *
 * Compaction recipes are hand-curated and still arrive only via migration 0003 — they
 * encode a crafting grid nobody can read automatically, so they are versioned data.
 *
 * Anvil recipes are different in kind and are written at runtime by the daily cron
 * (`buildAnvilRecipeUpsert`, called from rollup.ts). They are *derived* from the live
 * product list rather than authored, so freezing them into a migration would both stale
 * the enchant catalogue and leave a fresh database with zero rows where production has
 * ~620 — the replay divergence ADR-024 removed. Migration 0008 explains the reasoning at
 * length; CLAUDE.md section 2's "re-evaluated each run, never a migration" is the same
 * rule applied to tier assignment.
 */

export type RecipeKind = "compact" | "anvil";

export interface RecipeRow {
  readonly id: number;
  readonly base_tag: string;
  readonly ench_tag: string;
  readonly ratio: number;
  readonly verified: number;
  readonly note: string | null;
  readonly kind: RecipeKind;
}

const COLUMNS = "id, base_tag, ench_tag, ratio, verified, note, kind";

export async function selectAllRecipes(
  db: Pick<D1Database, "prepare">,
): Promise<RecipeRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM recipes ORDER BY base_tag, ench_tag`)
    .all<RecipeRow>();
  return results;
}

/** The compaction scan iterates these. Anvil edges are graph data, not scan rows — one
 *  row per 2:1 merge would be ~620 rows of noise and would blow D1's 1000-query cap
 *  (two series fetches per recipe), so they are scanned per family instead. */
export async function selectRecipesByKind(
  db: Pick<D1Database, "prepare">,
  kind: RecipeKind,
): Promise<RecipeRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM recipes WHERE kind = ?1 ORDER BY base_tag, ench_tag`)
    .bind(kind)
    .all<RecipeRow>();
  return results;
}

export async function selectRecipesByBaseTag(
  db: Pick<D1Database, "prepare">,
  baseTag: string,
): Promise<RecipeRow[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM recipes WHERE base_tag = ?1 ORDER BY ench_tag`)
    .bind(baseTag)
    .all<RecipeRow>();
  return results;
}

export interface AnvilRecipeRow {
  readonly baseTag: string;
  readonly enchTag: string;
  readonly ratio: number;
}

const PARAMS_PER_ROW = 5; // base_tag, ench_tag, ratio, verified, kind

/**
 * Upsert derived anvil edges.
 *
 * `verified` is written as 0 on insert and deliberately NOT touched on conflict: if
 * someone confirms a merge in-game and flips the flag, the next nightly sync must not
 * quietly undo that. `ratio` is refreshed, since it is derived and should track the code.
 *
 * Chunked by bound-parameter count, not row count — D1 caps params at 100 per query, so
 * ~620 rows becomes ~31 statements (CLAUDE.md section 3).
 */
export function buildAnvilRecipeUpsert(
  db: Pick<D1Database, "prepare">,
  rows: readonly AnvilRecipeRow[],
): D1PreparedStatement[] {
  return chunkByParamCount(rows, PARAMS_PER_ROW).map((chunk) => {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO recipes (base_tag, ench_tag, ratio, verified, kind)
      VALUES ${placeholders}
      ON CONFLICT(base_tag, ench_tag) DO UPDATE SET
        ratio = excluded.ratio,
        kind  = excluded.kind
    `;
    const args = chunk.flatMap((r) => [r.baseTag, r.enchTag, r.ratio, 0, "anvil"]);
    return db.prepare(sql).bind(...args);
  });
}

/**
 * Remove anvil edges whose tags are no longer listed on the bazaar — an enchant delisted,
 * or a rung that stopped trading.
 *
 * Expressed against `products` rather than against the derived keep-list on purpose. A
 * `NOT IN (...620 keys...)` would need 620 bound parameters against D1's cap of 100, and
 * chunking it is not an option: each chunk's NOT IN would delete precisely what the other
 * chunks intended to keep. This form binds nothing and cannot be split.
 *
 * Scoped to `kind = 'anvil'` so a derivation bug can never delete a hand-curated
 * compaction recipe.
 */
export function buildAnvilRecipePrune(db: Pick<D1Database, "prepare">): D1PreparedStatement {
  return db.prepare(
    `DELETE FROM recipes
      WHERE kind = 'anvil'
        AND (base_tag NOT IN (SELECT tag FROM products)
          OR ench_tag NOT IN (SELECT tag FROM products))`,
  );
}
