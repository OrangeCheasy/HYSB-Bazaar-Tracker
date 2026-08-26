import type { RunStatus, StatusPayload } from "@core/index.js";
import {
  selectLatestRunPerKind,
  selectLatestSuccessfulRun,
  type RunKind,
  type RunRow,
} from "../db/runs.js";
import { selectRowCounts } from "../db/status.js";
import type { Env } from "../index.js";
import { json } from "./index.js";

function shapeRun(row: RunRow | undefined): RunStatus | null {
  if (!row) return null;
  return {
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    ok: row.error === null,
    error: row.error,
  };
}

const KINDS: readonly RunKind[] = ["ingest", "rollup", "prune", "precompute"];

/**
 * GET /api/status — last ingest time, data age, row counts. Public (CLAUDE.md §3b:
 * "data freshness is a feature, not a secret").
 *
 * `dataAgeSeconds` is measured from the last SUCCESSFUL ingest, deliberately not from
 * the latest attempt: if ingest has been failing every 5 minutes, the latest attempt
 * is always "recent" even though no new data has landed. Measuring success keeps the
 * outage visible instead of averaging it away (CLAUDE.md §3b) — exactly the gap this
 * project's own R2-binding outage exposed before Phase 4 existed to report it.
 */
export async function handleStatus(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);

  const [latestPerKind, lastSuccessfulIngest, rowCounts] = await Promise.all([
    selectLatestRunPerKind(env.DB),
    selectLatestSuccessfulRun(env.DB, "ingest"),
    selectRowCounts(env.DB),
  ]);

  const byKind = new Map(latestPerKind.map((r) => [r.kind, r]));
  const runs: Record<RunKind, RunStatus | null> = {} as Record<RunKind, RunStatus | null>;
  for (const kind of KINDS) runs[kind] = shapeRun(byKind.get(kind));

  const lastIngestAt = lastSuccessfulIngest?.started_at ?? null;
  const dataAgeSeconds = lastIngestAt !== null ? now - lastIngestAt : null;

  const payload: StatusPayload = { lastIngestAt, dataAgeSeconds, rowCounts, runs };
  return json(
    payload,
    { generatedAt: now, staleAfter: now + 15, source: "d1" },
    200,
    // The whole point of this route is reporting how stale everything ELSE is — caching
    // it as long as a data route would let it lie about an active outage for minutes.
    // 15s is short enough to make a fresh outage visible almost immediately, long
    // enough that a monitoring poll doesn't hit D1 on every single check.
    "public, max-age=15",
  );
}
