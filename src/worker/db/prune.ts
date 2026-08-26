export interface PruneResult {
  readonly deleted: number;
  readonly moreRemaining: boolean;
}

/**
 * Delete rows older than `cutoff` in bounded batches, never one unbounded DELETE.
 * `snapshots`/`hourly` are ~430k/~50k rows respectively at full retention; a single
 * unbounded DELETE would blow D1's per-invocation limits. Stops after `maxBatches` and
 * reports `moreRemaining: true` so the caller knows the next scheduled run should
 * continue rather than assuming pruning finished (rollup.ts's own long-standing comment:
 * "the next run picks up where this one left off").
 *
 * D1 does not support `DELETE ... LIMIT` (needs a non-default SQLite compile flag,
 * not on D1's documented feature set). For a WITHOUT ROWID table with a composite key,
 * a row-value `IN (SELECT ... LIMIT n)` is the portable equivalent — supported since
 * SQLite 3.15, safe to assume on D1.
 *
 * `table`/`tsColumn` come from a fixed internal union, never user input, so string
 * interpolation here is not injectable — SQL parameters can't bind identifiers anyway.
 */
export async function boundedDelete(
  db: Pick<D1Database, "prepare">,
  table: "snapshots" | "hourly" | "daily",
  tsColumn: "ts" | "hour_ts" | "day_ts",
  cutoff: number,
  batchSize: number,
  maxBatches: number,
): Promise<PruneResult> {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await db
      .prepare(
        `DELETE FROM ${table}
         WHERE (tag, ${tsColumn}) IN (
           SELECT tag, ${tsColumn} FROM ${table} WHERE ${tsColumn} < ?1 LIMIT ?2
         )`,
      )
      .bind(cutoff, batchSize)
      .run();
    const changes = result.meta.changes;
    deleted += changes;
    if (changes < batchSize) return { deleted, moreRemaining: false };
  }
  return { deleted, moreRemaining: true };
}
