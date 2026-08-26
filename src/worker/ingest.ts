import {
  assignDepthToSides,
  computeDepthMetrics,
  deriveFamilies,
  err,
  isWellFormed,
  levelEndpointTags,
  normalizeMany,
  normalizeQuickStatus,
  ok,
  type NormalizeError,
  type RawOrderLevel,
  type RawQuickStatus,
  type Result,
} from "@core/index.js";
import { writeTickArchive } from "./archive.js";
import { buildProductsUpsert, type ProductRow } from "./db/products.js";
import { buildSnapshotsUpsert, type SnapshotRow } from "./db/snapshots.js";
import { buildHourlyIncrementalUpsert, type HourlyIncrementalRow } from "./db/hourly.js";
import { computeTierA } from "./db/tiers.js";
import { recordRun } from "./db/runs.js";
import type { Env } from "./index.js";

/** The only place api.hypixel.net may be called from — CLAUDE.md section 2. */

export interface RawBazaarProduct {
  readonly product_id: string;
  readonly sell_summary: readonly RawOrderLevel[];
  readonly buy_summary: readonly RawOrderLevel[];
  readonly quick_status?: RawQuickStatus;
}

export interface RawBazaarResponse {
  readonly success: boolean;
  readonly lastUpdated: number;
  readonly products: Record<string, RawBazaarProduct>;
}

export interface NormalizedProduct {
  readonly tag: string;
  readonly sellMovingWeek: number;
  readonly point: ReturnType<typeof normalizeQuickStatus>;
  readonly askDepthMetrics: ReturnType<typeof computeDepthMetrics>;
  readonly bidDepthMetrics: ReturnType<typeof computeDepthMetrics>;
}

export function normalizeProduct(
  entry: readonly [string, RawBazaarProduct],
  ts: number,
): Result<NormalizedProduct, NormalizeError> {
  const [tag, raw] = entry;
  if (!raw.quick_status) return err("missing-field");

  const point = normalizeQuickStatus(ts, raw.quick_status);
  if (!isWellFormed(point)) return err("crossed-book");

  const buyMetrics = computeDepthMetrics(raw.buy_summary ?? []);
  const sellMetrics = computeDepthMetrics(raw.sell_summary ?? []);
  const { ask, bid } = assignDepthToSides(point, raw.quick_status, buyMetrics, sellMetrics);

  return ok({
    tag,
    sellMovingWeek: raw.quick_status.sellMovingWeek,
    point,
    askDepthMetrics: ask,
    bidDepthMetrics: bid,
  });
}

/** The five-minute ingest cron's period. Every row a tick writes is stamped with the tick
 *  BOUNDARY rather than the wall clock, so that two deliveries of the same tick land on
 *  the same primary key and collapse via UPSERT.
 *
 *  This is load-bearing, not cosmetic. On 2026-08-25 Cloudflare delivered every cron
 *  twice, ~55s apart, for three and a half hours. Wall-clock stamps gave the two
 *  deliveries different `ts` values, so nothing collided: `snapshots` took two rows per
 *  tag per tick and `hourly.samples` counted 24 where it should have counted 12 — the
 *  one number CLAUDE.md section 3b relies on to stay honest. Quantizing makes a repeat
 *  delivery a no-op (`buildHourlyIncrementalUpsert`'s `last_tick_ts <` guard only fires
 *  when the repeat carries the SAME tickTs) and keeps the series evenly spaced, which
 *  stats.ts and profile.ts both assume. */
const TICK_SECONDS = 300;

/** Exported for the regression test: the 2026-08-25 duplicate-delivery pair must map to
 *  one boundary. Inlining this back into `runIngest` as `Date.now()` is the mistake this
 *  guards against. */
export function tickBoundary(epochSeconds: number): number {
  return Math.floor(epochSeconds / TICK_SECONDS) * TICK_SECONDS;
}

export async function runIngest(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  // `startedAt` stays wall-clock for `runs` bookkeeping — when a tick actually executed
  // is exactly what an operator needs to see there. Only the DATA is quantized.
  const tickTs = tickBoundary(startedAt);
  const t0 = Date.now();

  try {
    const res = await fetch(env.HYPIXEL_BAZAAR_URL);
    if (!res.ok) throw new Error(`hypixel returned ${res.status}`);
    const rawJson = await res.text();
    const data = JSON.parse(rawJson) as RawBazaarResponse;
    const entries = Object.entries(data.products);

    const { ok: normalized, skipped } = normalizeMany(entries, (entry) =>
      normalizeProduct(entry, tickTs),
    );

    // Tier A = COMPACTION recipe tags, plus top ~500 by sellMovingWeek, plus the lowest
    // and highest rung of every enchant family — recomputed every tick, CLAUDE.md
    // section 2. Never a static list, never a migration.
    //
    // The `kind = 'compact'` filter is load-bearing. Anvil edges also live in `recipes`,
    // and unioning their tags the way compaction tags are unioned would promote all 777
    // book tags rather than the ~295 level endpoints — roughly 1,270 Tier A tags instead
    // of ~795, and ~394 MB of snapshots against the ~243 MB section 2 budgets for. The
    // endpoints are 91% of book coin turnover; the rungs in between are waypoints a merge
    // passes through, not things anyone trades, and `hourly` covers them fine.
    const recipeRows = await env.DB.prepare(
      "SELECT base_tag, ench_tag FROM recipes WHERE kind = 'compact'",
    ).all<{ base_tag: string; ench_tag: string }>();
    const recipeTags = new Set<string>();
    for (const r of recipeRows.results) {
      recipeTags.add(r.base_tag);
      recipeTags.add(r.ench_tag);
    }
    for (const tag of levelEndpointTags(deriveFamilies(normalized.map((p) => p.tag)))) {
      recipeTags.add(tag);
    }
    const bySellMovingWeekDesc = [...normalized]
      .sort((a, b) => b.sellMovingWeek - a.sellMovingWeek)
      .map((p) => p.tag);
    const tierA = computeTierA([...recipeTags], bySellMovingWeekDesc, 500);

    const productRows: ProductRow[] = [];
    const snapshotRows: SnapshotRow[] = [];
    const hourlyRows: HourlyIncrementalRow[] = [];
    const hourTs = Math.floor(tickTs / 3600) * 3600;

    for (const p of normalized) {
      const tier = tierA.has(p.tag) ? "A" : "B";
      productRows.push({
        tag: p.tag,
        isEnchanted: p.tag.startsWith("ENCHANTED_"),
        tier,
        ts: tickTs,
      });

      if (tier === "A") {
        snapshotRows.push({
          tag: p.tag,
          ts: tickTs,
          ask: p.point.ask,
          bid: p.point.bid,
          askDepth: p.point.askDepth,
          bidDepth: p.point.bidDepth,
          ibWeek: p.point.ibWeek,
          isWeek: p.point.isWeek,
          askDepth1pct: p.askDepthMetrics.depth1pct,
          bidDepth1pct: p.bidDepthMetrics.depth1pct,
          askDepth5pct: p.askDepthMetrics.depth5pct,
          bidDepth5pct: p.bidDepthMetrics.depth5pct,
          askMaxWall: p.askDepthMetrics.maxWall,
          bidMaxWall: p.bidDepthMetrics.maxWall,
          askOrderCount: p.askDepthMetrics.orderCount,
          bidOrderCount: p.bidDepthMetrics.orderCount,
        });
      } else {
        hourlyRows.push({
          tag: p.tag,
          hourTs,
          ask: p.point.ask,
          bid: p.point.bid,
          askDepth: p.point.askDepth,
          bidDepth: p.point.bidDepth,
          ibWeek: p.point.ibWeek,
          isWeek: p.point.isWeek,
          tickTs,
        });
      }
    }

    let rowsWritten = 0;
    const productStmts = buildProductsUpsert(env.DB, productRows);
    if (productStmts.length > 0) {
      await env.DB.batch(productStmts);
      rowsWritten += productRows.length;
    }
    const snapshotStmts = buildSnapshotsUpsert(env.DB, snapshotRows);
    if (snapshotStmts.length > 0) {
      await env.DB.batch(snapshotStmts);
      rowsWritten += snapshotRows.length;
    }
    const hourlyStmts = buildHourlyIncrementalUpsert(env.DB, hourlyRows);
    if (hourlyStmts.length > 0) {
      await env.DB.batch(hourlyStmts);
      rowsWritten += hourlyRows.length;
    }

    await writeTickArchive(env, tickTs, rawJson);

    // Skips are expected, routine behaviour (ROADMAP Phase 2: "a product with a missing
    // quick_status must be skipped, not fatal"), not run failures — recordRun's `error`
    // column stays null for these. Logged instead, so they're visible in `wrangler tail`
    // without a schema change (RunResult has no dedicated skip-count columns yet).
    if (skipped.length > 0) {
      const missingQuickStatus = skipped.filter((s) => s.error === "missing-field").length;
      const crossedBooks = skipped.filter((s) => s.error === "crossed-book").length;
      console.warn(
        `ingest: skipped ${skipped.length}/${entries.length} products ` +
          `(missing quick_status: ${missingQuickStatus}, crossed book: ${crossedBooks})`,
      );
    }

    await recordRun(env, "ingest", startedAt, Date.now() - t0, {
      productsSeen: entries.length,
      rowsWritten,
    });
  } catch (e) {
    await recordRun(env, "ingest", startedAt, Date.now() - t0, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
