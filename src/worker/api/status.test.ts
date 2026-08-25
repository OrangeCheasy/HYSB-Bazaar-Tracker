import { describe, expect, it } from "vitest";
import type { RowCounts } from "../db/status.js";
import { makeFakeEnv, makeQueuedFakeD1 } from "../test/apiFakes.js";
import { handleStatus } from "./status.js";

describe("handleStatus — stale data", () => {
  it("measures dataAgeSeconds from the last SUCCESSFUL ingest, not the latest (failing) attempt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const recentFailedAttempt = now - 300; // ingest has been retrying every 5 minutes...
    const lastRealSuccess = now - 6 * 3600; // ...but nothing has actually landed in 6 hours

    const latestPerKindRows = [
      {
        id: 99,
        kind: "ingest",
        started_at: recentFailedAttempt,
        duration_ms: 0,
        products_seen: null,
        rows_written: null,
        rows_deleted: null,
        db_size_bytes: null,
        error: "not implemented",
      },
      {
        id: 50,
        kind: "rollup",
        started_at: now - 1200,
        duration_ms: 500,
        products_seen: 40,
        rows_written: 40,
        rows_deleted: null,
        db_size_bytes: null,
        error: null,
      },
    ];
    const lastSuccessfulIngestRow = {
      id: 42,
      kind: "ingest",
      started_at: lastRealSuccess,
      duration_ms: 2000,
      products_seen: 2136,
      rows_written: 4272,
      rows_deleted: null,
      db_size_bytes: null,
      error: null,
    };
    const rowCounts: RowCounts = { products: 2136, snapshots: 1000, hourly: 1600, daily: 0, recipes: 42 };

    const db = makeQueuedFakeD1({
      all: [latestPerKindRows],
      first: [lastSuccessfulIngestRow, rowCounts],
    });

    const res = await handleStatus(makeFakeEnv({ db }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        lastIngestAt: number | null;
        dataAgeSeconds: number | null;
        rowCounts: RowCounts;
        runs: { ingest: { startedAt: number; ok: boolean; error: string | null } | null };
      };
    };

    // The outage must stay visible: dataAgeSeconds reflects the OLD success, not the
    // recent-but-failing attempt (CLAUDE.md §3b — this is the exact gap that let the
    // "not implemented" R2-binding outage run undetected before this endpoint existed).
    expect(body.data.lastIngestAt).toBe(lastRealSuccess);
    expect(body.data.dataAgeSeconds).toBe(now - lastRealSuccess);
    expect(body.data.dataAgeSeconds).toBeGreaterThan(3600);

    // The latest-attempt breakdown still shows the failure separately.
    expect(body.data.runs.ingest?.ok).toBe(false);
    expect(body.data.runs.ingest?.error).toBe("not implemented");
    expect(body.data.runs.ingest?.startedAt).toBe(recentFailedAttempt);

    expect(body.data.rowCounts).toEqual(rowCounts);
  });

  it("reports null lastIngestAt/dataAgeSeconds when ingest has never once succeeded", async () => {
    const db = makeQueuedFakeD1({
      all: [[]],
      first: [null, { products: 0, snapshots: 0, hourly: 0, daily: 0, recipes: 0 }],
    });

    const res = await handleStatus(makeFakeEnv({ db }));
    const body = (await res.json()) as { data: { lastIngestAt: null; dataAgeSeconds: null } };
    expect(body.data.lastIngestAt).toBeNull();
    expect(body.data.dataAgeSeconds).toBeNull();
  });
});
