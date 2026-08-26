import { precomputeBandScan } from "./bandScan.js";
import { recordRun } from "./db/runs.js";
import { DEFAULT_SCAN_PARAMS, runScan } from "./scan.js";
import type { Env } from "./index.js";

/** KV key for the precomputed default-parameter scan. Versioned so a future payload
 *  shape change can ship without needing to migrate or clear old KV data — an old key
 *  just falls out of use, and `/api/scan` (api/scan.ts) falls back to a live D1 compute
 *  when the key it looks for is missing. */
export const SCAN_KV_KEY = "scan:default:v1";

/** Generous relative to the hourly cron cadence this key is rewritten on: if the KV
 *  read in api/scan.ts still returns a payload older than this, something well beyond
 *  "haven't run this hour yet" is wrong (CLAUDE.md §3b: an outage must stay visible,
 *  not get quietly averaged away by an ever-renewing staleAfter). */
const SCAN_STALE_AFTER_SECONDS = 2 * 3600;

/**
 * Runs right after the hourly rollup (src/worker/index.ts's CRON_HOURLY branch), so it
 * always reads the hour that rollup just finished writing. Writes the finished scan to
 * KV so `/api/scan` with default params is a single ~5ms read instead of a D1 fan-out
 * (CLAUDE.md §3: KV holds precomputed payloads written by cron, never per-request).
 */
export async function runPrecompute(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  try {
    const result = await runScan(env.DB, DEFAULT_SCAN_PARAMS, startedAt);

    // meta.generatedAt is the underlying DATA's freshness (the oldest "latest bar"
    // among included rows), not wall-clock "when precompute ran" — the two usually
    // match within seconds, but diverge exactly when the cron has been failing, which
    // is the one case this number must stay honest for (CLAUDE.md §5).
    const payload = {
      data: result.rows,
      meta: {
        generatedAt: result.dataTo,
        staleAfter: result.dataTo + SCAN_STALE_AFTER_SECONDS,
        source: "kv" as const,
      },
    };
    await env.CACHE.put(SCAN_KV_KEY, JSON.stringify(payload));

    // The band scan shares this cron because it has the same cadence: a band only moves
    // when a new hour lands, and the rollup that produced that hour just ran. Written as
    // a second key rather than folded into the first — they are different payloads with
    // different consumers, and a shape change to one should not invalidate the other.
    const bandRows = await precomputeBandScan(env, startedAt);

    await recordRun(env, "precompute", startedAt, Date.now() - t0, {
      productsSeen: result.rows.length + bandRows,
      rowsWritten: 2,
    });
  } catch (e) {
    await recordRun(env, "precompute", startedAt, Date.now() - t0, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
