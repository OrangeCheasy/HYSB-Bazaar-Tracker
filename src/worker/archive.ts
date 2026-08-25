import type { Env } from "./index.js";

/**
 * R2 archive of raw Hypixel responses. One small object per ingest tick, NOT one bundled
 * object per day as CLAUDE.md section 3 currently (still) says — see ADR-016 for why:
 * R2 multipart uploads need a 5MB minimum part size (a tick's ~481KB gzipped payload is
 * 10x too small), and Workers isolates cap at 128MB memory, unsafe for holding a growing
 * ~136MB/day blob to decompress/re-upload every 5 minutes. Per-tick objects sidestep
 * both limits entirely and cost ~0.9% of R2's free monthly operation allowance at this
 * volume.
 */

const FULL_RETENTION_DAYS = 14;

// A quick_status-only tick is roughly 10-20% of a full tick's gzipped size (measured
// 19.3% in the Phase 0.5 spike). Threshold sits well above that so pruneArchiveDetail
// treats an already-downgraded object as a no-op by size alone, with no extra
// bookkeeping (metadata flags, a separate "done" list) needed to stay idempotent.
const DOWNGRADE_SIZE_THRESHOLD_BYTES = 150_000;

function dateKey(tickTs: number): string {
  return new Date(tickTs * 1000).toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function hhmmKey(tickTs: number): string {
  const d = new Date(tickTs * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

/**
 * R2's put() rejects a live ReadableStream with no known length — CompressionStream's
 * output length isn't known upfront, so it must be fully materialized first. Safe at
 * this scale: one tick is ~481KB gzipped, nowhere near the 128MB isolate memory cap
 * (that cap is exactly why the OLD daily-bundle design, ~136MB/day, was unsafe — a
 * single tick is a different scale entirely).
 */
async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Gzip and write this tick's full raw payload. Called from ingest.ts every 5 minutes. */
export async function writeTickArchive(
  env: Env,
  tickTs: number,
  rawJson: string,
): Promise<void> {
  const key = `archive/${dateKey(tickTs)}/${hhmmKey(tickTs)}.json.gz`;
  await env.ARCHIVE.put(key, await gzip(rawJson), {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
  });
}

interface ArchivedProduct {
  readonly quick_status?: unknown;
}
interface ArchivedResponse {
  readonly products: Record<string, ArchivedProduct>;
}

/**
 * Downgrade one day's worth of tick archives from full order books to quick_status only,
 * once that day turns FULL_RETENTION_DAYS old. Processes exactly the single date that
 * crosses the boundary on this run (today minus 15 days), not a backlog scan — if a run
 * is missed, the next daily run only catches up the one day it's actually responsible
 * for; this is a target from CLAUDE.md section 3, not a deadline enforced to the hour.
 * Called once daily from rollup.ts's runDailyRollup, alongside D1 pruning.
 */
export async function pruneArchiveDetail(
  env: Env,
  nowTs: number,
): Promise<{ readonly checked: number; readonly downgraded: number }> {
  const targetDate = dateKey(nowTs - (FULL_RETENTION_DAYS + 1) * 86_400);
  const prefix = `archive/${targetDate}/`;

  let checked = 0;
  let downgraded = 0;
  let cursor: string | undefined;

  do {
    const page = await env.ARCHIVE.list({ prefix, cursor });
    for (const obj of page.objects) {
      checked++;
      if (obj.size <= DOWNGRADE_SIZE_THRESHOLD_BYTES) continue; // already downgraded

      const full = await env.ARCHIVE.get(obj.key);
      if (!full) continue;

      const text = await new Response(
        full.body.pipeThrough(new DecompressionStream("gzip")),
      ).text();
      const data = JSON.parse(text) as ArchivedResponse;
      const quickStatusOnly = Object.fromEntries(
        Object.entries(data.products).map(([tag, p]) => [tag, p.quick_status]),
      );

      await env.ARCHIVE.put(obj.key, await gzip(JSON.stringify(quickStatusOnly)), {
        httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
      });
      downgraded++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { checked, downgraded };
}
