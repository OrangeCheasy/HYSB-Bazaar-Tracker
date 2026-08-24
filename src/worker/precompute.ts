import { recordRun } from "./db/runs.js";
import type { Env } from "./index.js";

/**
 * Phase 5. Run the craft scan over the freshest `hourly` data and write the finished
 * payload to KV, so a user request is one ~5ms KV read rather than a query fan-out.
 *
 * KV is eventually consistent (~60s global propagation) and write-limited, so this is
 * the only place that writes to CACHE. Never write KV from a request handler.
 */
export async function runPrecompute(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  console.warn("precompute: not implemented yet (Phase 5)");

  await recordRun(env, "precompute", startedAt, Date.now() - t0, { error: "not implemented" });
}
