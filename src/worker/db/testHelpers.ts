/** A fake D1Database that records prepared SQL + bound args instead of executing them.
 *  Enough to unit-test the SQL builders in this directory without a real D1 instance —
 *  SQL-dialect correctness (does the upsert actually behave right in real SQLite) is
 *  covered separately by scripts/db-smoke.sh against a real local D1. */
export interface RecordedStatement {
  readonly sql: string;
  readonly args: readonly unknown[];
}

export function makeFakeD1(): {
  db: Pick<D1Database, "prepare">;
  statements: RecordedStatement[];
} {
  const statements: RecordedStatement[] = [];
  const db: Pick<D1Database, "prepare"> = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          statements.push({ sql, args });
          return stmt as unknown as D1PreparedStatement;
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return { db, statements };
}
