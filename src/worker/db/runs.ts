import type { Env } from "../index.js";

export type RunKind = "ingest" | "rollup" | "prune" | "precompute";

export interface RunResult {
  productsSeen?: number;
  rowsWritten?: number;
  /** Deletes count as rows written too — CLAUDE.md section 3 — track them separately
   *  so pruning's cost is visible, not folded silently into rowsWritten. */
  rowsDeleted?: number;
  /** Nightly estimate, not an exact `wrangler d1 info` byte count — see rollup.ts. */
  dbSizeBytes?: number;
  error?: string;
}

/**
 * Record one cron execution. You cannot debug a cron you cannot see.
 *
 * Deliberately swallows its own failures: a broken observability write must never take
 * down the job it is observing.
 */
export async function recordRun(
  env: Env,
  kind: RunKind,
  startedAt: number,
  durationMs: number,
  result: RunResult = {},
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO runs (kind, started_at, duration_ms, products_seen, rows_written,
                          rows_deleted, db_size_bytes, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        kind,
        startedAt,
        durationMs,
        result.productsSeen ?? null,
        result.rowsWritten ?? null,
        result.rowsDeleted ?? null,
        result.dbSizeBytes ?? null,
        result.error ?? null,
      )
      .run();
  } catch (err) {
    console.error(`recordRun(${kind}) failed:`, err);
  }
}
