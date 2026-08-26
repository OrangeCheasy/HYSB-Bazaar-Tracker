import { describe, expect, it } from "vitest";
import { boundedDelete } from "./prune.js";

/**
 * Fake D1 that records SQL and returns a caller-supplied number of changes per batch.
 * `makeFakeD1` in testHelpers.ts only records `bind()` and has no `run()`, which is what
 * boundedDelete actually calls — hence a local fake rather than a shared one.
 */
function makeFakeDb(changesPerCall: readonly number[]) {
  const calls: { sql: string; args: readonly unknown[] }[] = [];
  let i = 0;
  const db: Pick<D1Database, "prepare"> = {
    prepare(sql: string) {
      const stmt = {
        bind(...args: unknown[]) {
          calls.push({ sql, args });
          return stmt as unknown as D1PreparedStatement;
        },
        run() {
          const changes = changesPerCall[i] ?? 0;
          i++;
          return Promise.resolve({ meta: { changes } });
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
  return { db, calls };
}

describe("boundedDelete", () => {
  it("targets the daily table by day_ts", async () => {
    // `daily` was never pruned at all before ADR-021 — the table/column unions did not
    // even admit it. This asserts the wiring exists, not just that it typechecks.
    const { db, calls } = makeFakeDb([3]);
    const result = await boundedDelete(db, "daily", "day_ts", 1_700_000_000, 500, 20);

    expect(result).toEqual({ deleted: 3, moreRemaining: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain("DELETE FROM daily");
    expect(calls[0]?.sql).toContain("day_ts");
    expect(calls[0]?.args).toEqual([1_700_000_000, 500]);
  });

  it("stops early when a batch comes back short, without a wasted extra query", async () => {
    const { db, calls } = makeFakeDb([500, 500, 12]);
    const result = await boundedDelete(db, "hourly", "hour_ts", 1_700_000_000, 500, 20);

    expect(result).toEqual({ deleted: 1012, moreRemaining: false });
    expect(calls).toHaveLength(3);
  });

  it("reports moreRemaining when it exhausts its batch budget", async () => {
    // The signal the next nightly run needs. Reporting false here would silently strand
    // rows past retention forever.
    const { db, calls } = makeFakeDb([500, 500, 500]);
    const result = await boundedDelete(db, "snapshots", "ts", 1_700_000_000, 500, 3);

    expect(result).toEqual({ deleted: 1500, moreRemaining: true });
    expect(calls).toHaveLength(3);
  });
});
