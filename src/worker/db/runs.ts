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

/** Read-side, for `/api/status` (Phase 4). */
export interface RunRow {
  readonly id: number;
  readonly kind: RunKind;
  readonly started_at: number;
  readonly duration_ms: number | null;
  readonly products_seen: number | null;
  readonly rows_written: number | null;
  readonly rows_deleted: number | null;
  readonly db_size_bytes: number | null;
  readonly error: string | null;
}

/**
 * The most recent run of each kind, success or failure — one row per kind. Lets
 * `/api/status` show "the last attempt errored" even when a run before it succeeded,
 * rather than only ever surfacing successes.
 */
export async function selectLatestRunPerKind(
  db: Pick<D1Database, "prepare">,
): Promise<RunRow[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.kind, r.started_at, r.duration_ms, r.products_seen, r.rows_written,
              r.rows_deleted, r.db_size_bytes, r.error
       FROM runs r
       INNER JOIN (SELECT kind, MAX(id) AS max_id FROM runs GROUP BY kind) latest
         ON latest.kind = r.kind AND latest.max_id = r.id`,
    )
    .all<RunRow>();
  return results;
}

/**
 * The most recent run that actually wrote data, separate from the latest attempt.
 * "Data age" must be measured from here, not from `selectLatestRunPerKind`'s ingest
 * row — otherwise a string of failing retries would make data look fresher than it is
 * (CLAUDE.md §3b: an outage must be visible, not averaged away).
 */
export async function selectLatestSuccessfulRun(
  db: Pick<D1Database, "prepare">,
  kind: RunKind,
): Promise<RunRow | null> {
  const row = await db
    .prepare(
      `SELECT id, kind, started_at, duration_ms, products_seen, rows_written,
              rows_deleted, db_size_bytes, error
       FROM runs WHERE kind = ?1 AND error IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(kind)
    .first<RunRow>();
  return row ?? null;
}
