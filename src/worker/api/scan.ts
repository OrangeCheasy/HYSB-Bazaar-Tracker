import { SCAN_KV_KEY } from "../precompute.js";
import { isDefaultScanParams, parseScanQueryParams, runScan } from "../scan.js";
import type { Env } from "../index.js";
import { json, type Meta } from "./index.js";

interface CachedScanPayload {
  readonly data: unknown;
  readonly meta: Meta;
}

/**
 * GET /api/scan?tax=&capture=&tick=&sleepStart=&sleepEnd=&window=&capital=
 *
 * Default params: a single KV read of precompute.ts's output (source: "kv"). Its
 * `meta` is served exactly as stored — NOT regenerated here — so if the hourly cron
 * has stopped running, `staleAfter` is honestly in the past instead of being silently
 * refreshed to "now" just because someone made a request (CLAUDE.md §5, §3b).
 *
 * Non-default params: recomputed live from `hourly` (source: "d1"). This is the
 * minority path — parameterized scans should not force the default path through D1 on
 * every request (ROADMAP Phase 4).
 */
export async function handleScan(url: URL, env: Env): Promise<Response> {
  const { params, capitalAvailable } = parseScanQueryParams(url);

  if (isDefaultScanParams(params, capitalAvailable)) {
    const raw = await env.CACHE.get(SCAN_KV_KEY);
    if (raw !== null) {
      const cached = JSON.parse(raw) as CachedScanPayload;
      return json(
        cached.data,
        cached.meta,
        200,
        // Matches KV's own eventual-consistency window (~60s global propagation,
        // CLAUDE.md §3) — caching shorter buys nothing since KV itself cannot
        // propagate faster than that, and the underlying scan only changes hourly
        // anyway so caching longer would not meaningfully reduce load either.
        "public, max-age=60",
      );
    }
    // KV has never been written (fresh deploy, before the first hourly cron) — fall
    // through to a live compute rather than 404ing on a legitimate default request.
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await runScan(env.DB, params, now, capitalAvailable);
  return json(
    result.rows,
    { generatedAt: result.dataTo, staleAfter: result.dataTo + 3600, source: "d1" },
    200,
    // Same 60s TTL as the KV path: the underlying `hourly` data changes at most once
    // an hour, so a longer TTL would not serve fresher data, only stale data for
    // longer if a parameter combination happens to get shared and hit repeatedly.
    "public, max-age=60",
  );
}
