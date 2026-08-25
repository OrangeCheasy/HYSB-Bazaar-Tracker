/** For `/api/status` (Phase 4). One round trip via subselects rather than five separate
 *  COUNT queries — D1's per-invocation query budget (1000) is generous, but there is no
 *  reason to spend five queries on what one can answer. */
export interface RowCounts {
  readonly products: number;
  readonly snapshots: number;
  readonly hourly: number;
  readonly daily: number;
  readonly recipes: number;
}

export async function selectRowCounts(
  db: Pick<D1Database, "prepare">,
): Promise<RowCounts> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM products) AS products,
         (SELECT COUNT(*) FROM snapshots) AS snapshots,
         (SELECT COUNT(*) FROM hourly) AS hourly,
         (SELECT COUNT(*) FROM daily) AS daily,
         (SELECT COUNT(*) FROM recipes) AS recipes`,
    )
    .first<RowCounts>();
  return row ?? { products: 0, snapshots: 0, hourly: 0, daily: 0, recipes: 0 };
}
