import { chunkByParamCount } from "./chunk.js";

export interface ProductRow {
  readonly tag: string;
  readonly isEnchanted: boolean;
  readonly tier: "A" | "B";
  /** This tick's timestamp. Only used as `first_seen` on the very first insert — the
   *  ON CONFLICT clause deliberately never touches first_seen, so an already-known tag
   *  keeps its true first-seen date no matter how many times this upsert runs. */
  readonly ts: number;
}

const PARAMS_PER_ROW = 5; // tag, is_enchanted, tier, first_seen, last_seen

/** Every ingest tick upserts every fetched tag here, regardless of tier. */
export function buildProductsUpsert(
  db: Pick<D1Database, "prepare">,
  rows: readonly ProductRow[],
): D1PreparedStatement[] {
  return chunkByParamCount(rows, PARAMS_PER_ROW).map((chunk) => {
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const sql = `
      INSERT INTO products (tag, is_enchanted, tier, first_seen, last_seen)
      VALUES ${placeholders}
      ON CONFLICT(tag) DO UPDATE SET
        is_enchanted = excluded.is_enchanted,
        tier         = excluded.tier,
        last_seen    = excluded.last_seen
    `;
    const args = chunk.flatMap((r) => [r.tag, r.isEnchanted ? 1 : 0, r.tier, r.ts, r.ts]);
    return db.prepare(sql).bind(...args);
  });
}
