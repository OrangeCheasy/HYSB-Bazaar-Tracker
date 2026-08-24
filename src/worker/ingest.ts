import { recordRun } from "./db/runs.js";
import type { Env } from "./index.js";

/**
 * Phase 2. Pull the single Hypixel bazaar call (~1500 products, no API key) and write
 * one row per product into `snapshots`.
 *
 * When implementing, mind CLAUDE.md §3: never loop INSERT per product. Build multi-row
 * INSERTs chunked by BOUND PARAMETER count (cap 100 per query), not by row count.
 *
 * This is the ONLY place api.hypixel.net may be called from.
 */
export async function runIngest(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  console.warn("ingest: not implemented yet (Phase 2)");

  await recordRun(env, "ingest", startedAt, Date.now() - t0, {
    error: "not implemented",
  });
}
