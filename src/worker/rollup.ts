import { recordRun } from "./db/runs.js";
import type { Env } from "./index.js";

/**
 * Phase 3. Fold the last hour of `snapshots` into one `hourly` row per product.
 */
export async function runHourlyRollup(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  console.warn("hourly rollup: not implemented yet (Phase 3)");

  await recordRun(env, "rollup", startedAt, Date.now() - t0, { error: "not implemented" });
}

/**
 * Phase 3. Fold yesterday's `hourly` rows into `daily`, then prune `snapshots` older
 * than 7 days.
 *
 * Pruning is the part that bites: ~430k rows/day means a single unbounded DELETE will
 * blow past D1's per-invocation limits. Delete in bounded batches and stop early if the
 * budget runs out — the next run picks up where this one left off.
 */
export async function runDailyRollup(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  console.warn("daily rollup + prune: not implemented yet (Phase 3)");

  await recordRun(env, "prune", startedAt, Date.now() - t0, { error: "not implemented" });
}
