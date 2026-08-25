import {
  aggregate,
  aggregateBars,
  err,
  normalizeHourlyRow,
  normalizeMany,
  normalizeSnapshotRow,
  ok,
  type Bar,
  type NormalizeError,
  type Point,
  type RawHourlyRow,
  type RawSnapshotRow,
  type Result,
} from "@core/index.js";
import { pruneArchiveDetail } from "./archive.js";
import { buildDailyUpsert, type DailyRow } from "./db/daily.js";
import { buildHourlyReplaceUpsert, type HourlyReplaceRow } from "./db/hourly.js";
import { boundedDelete } from "./db/prune.js";
import { recordRun } from "./db/runs.js";
import type { Env } from "./index.js";

const HOUR = 3600;
const DAY = 86_400;
const SNAPSHOT_RETENTION_SECONDS = 7 * DAY;
const HOURLY_RETENTION_SECONDS = 90 * DAY;
const PRUNE_BATCH_SIZE = 500;
const PRUNE_MAX_BATCHES = 20; // up to 10,000 rows/table/run; next run continues if more remain

// Measured bytes/row from a live payload (CLAUDE.md section 3, Phase 0.5). An estimate
// for trend-watching between the monthly manual `npx wrangler d1 info bazaar` check —
// D1 does not expose PRAGMA page_count/page_size (not on its documented PRAGMA
// allowlist), and an exact byte count needs the Cloudflare API with an account-scoped
// token this project deliberately doesn't add for this.
const ESTIMATED_SNAPSHOT_ROW_BYTES = 154;
const ESTIMATED_HOURLY_ROW_BYTES = 184;

function groupByTag<T extends { readonly tag: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const existing = groups.get(row.tag);
    if (existing) existing.push(row);
    else groups.set(row.tag, [row]);
  }
  return groups;
}

interface TaggedSnapshotRow extends RawSnapshotRow {
  readonly tag: string;
}

function normalizeTaggedSnapshot(
  row: TaggedSnapshotRow,
): Result<{ tag: string; point: Point }, NormalizeError> {
  const result = normalizeSnapshotRow(row);
  if (!result.ok) return err(result.error);
  return ok({ tag: row.tag, point: result.value });
}

/**
 * Tier A only, runs at :07 past the hour — folds the hour that just completed from
 * `snapshots` into one `hourly` row per tag. Reuses packages/core's aggregate() instead
 * of hand-rolling SQL aggregation, so rollup.ts stays "nothing but SQL and plumbing"
 * (that comment lives on aggregate() itself).
 */
export async function runHourlyRollup(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  try {
    const targetHourStart = Math.floor(startedAt / HOUR) * HOUR - HOUR;
    const targetHourEnd = targetHourStart + HOUR;

    const { results } = await env.DB.prepare(
      `SELECT s.tag, s.ts, s.ask, s.bid, s.ask_depth, s.bid_depth, s.ib_week, s.is_week
       FROM snapshots s
       JOIN products p ON p.tag = s.tag
       WHERE p.tier = 'A' AND s.ts >= ?1 AND s.ts < ?2`,
    )
      .bind(targetHourStart, targetHourEnd)
      .all<TaggedSnapshotRow>();

    const { ok: normalized, skipped } = normalizeMany(results, normalizeTaggedSnapshot);
    if (skipped.length > 0) {
      // ADR-006: a crossed row here means ingest wrote bad data, not a rollup bug.
      // Report it rather than silently dropping it.
      console.warn(`hourly rollup: ${skipped.length} crossed snapshot row(s) skipped`);
    }

    const byTag = groupByTag(normalized.map((n) => ({ tag: n.tag, ...n.point })));
    const rows: HourlyReplaceRow[] = [];
    for (const [tag, points] of byTag) {
      // Every point in this group already falls inside [targetHourStart, targetHourEnd),
      // so aggregate() always produces exactly one bucket here.
      const [bar] = aggregate(points, HOUR, "hypixel");
      if (!bar) continue;
      rows.push({
        tag,
        hourTs: targetHourStart,
        askAvg: bar.askAvg,
        askMin: bar.askMin,
        askMax: bar.askMax,
        bidAvg: bar.bidAvg,
        bidMin: bar.bidMin,
        bidMax: bar.bidMax,
        askDepth: bar.askDepth,
        bidDepth: bar.bidDepth,
        ibWeek: bar.ibWeek,
        isWeek: bar.isWeek,
        samples: bar.samples,
        source: bar.source,
      });
    }

    const stmts = buildHourlyReplaceUpsert(env.DB, rows);
    if (stmts.length > 0) await env.DB.batch(stmts);

    await recordRun(env, "rollup", startedAt, Date.now() - t0, {
      productsSeen: byTag.size,
      rowsWritten: rows.length,
    });
  } catch (e) {
    await recordRun(env, "rollup", startedAt, Date.now() - t0, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

interface TaggedHourlyRow extends RawHourlyRow {
  readonly tag: string;
}

function normalizeTaggedHourly(
  row: TaggedHourlyRow,
): Result<{ tag: string; bar: Bar }, NormalizeError> {
  const result = normalizeHourlyRow(row);
  if (!result.ok) return err(result.error);
  return ok({ tag: row.tag, bar: result.value });
}

/**
 * Runs at 04:23 daily. Two jobs: roll up yesterday's `hourly` (both tiers) into `daily`,
 * then bounded-prune `snapshots` past 7 days and `hourly` past 90 days. Also downgrades
 * one day's worth of R2 archive detail once it turns 14 days old (CLAUDE.md section 3 /
 * ADR-016) and records an estimated DB size into `runs`.
 */
export async function runDailyRollup(env: Env): Promise<void> {
  const startedAt = Math.floor(Date.now() / 1000);
  const t0 = Date.now();

  try {
    const targetDayStart = Math.floor(startedAt / DAY) * DAY - DAY;
    const targetDayEnd = targetDayStart + DAY;

    const { results } = await env.DB.prepare(
      `SELECT tag, hour_ts, ask_avg, ask_min, ask_max, bid_avg, bid_min, bid_max,
              ask_depth, bid_depth, ib_week, is_week, samples, source
       FROM hourly
       WHERE hour_ts >= ?1 AND hour_ts < ?2`,
    )
      .bind(targetDayStart, targetDayEnd)
      .all<TaggedHourlyRow>();

    const { ok: normalized, skipped } = normalizeMany(results, normalizeTaggedHourly);
    if (skipped.length > 0) {
      console.warn(`daily rollup: ${skipped.length} crossed hourly row(s) skipped`);
    }

    const byTag = groupByTag(normalized.map((n) => ({ tag: n.tag, ...n.bar })));
    const dailyRows: DailyRow[] = [];
    for (const [tag, bars] of byTag) {
      const [day] = aggregateBars(bars, DAY);
      if (!day) continue;
      dailyRows.push({
        tag,
        dayTs: targetDayStart,
        askAvg: day.askAvg,
        askMin: day.askMin,
        askMax: day.askMax,
        bidAvg: day.bidAvg,
        bidMin: day.bidMin,
        bidMax: day.bidMax,
        ibWeek: day.ibWeek,
        isWeek: day.isWeek,
        samples: day.samples,
      });
    }

    const dailyStmts = buildDailyUpsert(env.DB, dailyRows);
    if (dailyStmts.length > 0) await env.DB.batch(dailyStmts);

    const snapshotPrune = await boundedDelete(
      env.DB,
      "snapshots",
      "ts",
      startedAt - SNAPSHOT_RETENTION_SECONDS,
      PRUNE_BATCH_SIZE,
      PRUNE_MAX_BATCHES,
    );
    const hourlyPrune = await boundedDelete(
      env.DB,
      "hourly",
      "hour_ts",
      startedAt - HOURLY_RETENTION_SECONDS,
      PRUNE_BATCH_SIZE,
      PRUNE_MAX_BATCHES,
    );
    if (snapshotPrune.moreRemaining || hourlyPrune.moreRemaining) {
      console.warn(
        `daily prune: budget exhausted, more rows remain ` +
          `(snapshots moreRemaining=${snapshotPrune.moreRemaining}, ` +
          `hourly moreRemaining=${hourlyPrune.moreRemaining}) — next run continues`,
      );
    }

    const archivePrune = await pruneArchiveDetail(env, startedAt);
    if (archivePrune.downgraded > 0) {
      console.log(
        `daily prune: downgraded ${archivePrune.downgraded}/${archivePrune.checked} ` +
          `archive object(s) to quick_status-only`,
      );
    }

    const snapshotCountRow = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM snapshots",
    ).first<{ n: number }>();
    const hourlyCountRow = await env.DB.prepare("SELECT COUNT(*) as n FROM hourly").first<{
      n: number;
    }>();
    const snapshotCount = snapshotCountRow?.n ?? 0;
    const hourlyCount = hourlyCountRow?.n ?? 0;
    const dbSizeBytes =
      snapshotCount * ESTIMATED_SNAPSHOT_ROW_BYTES + hourlyCount * ESTIMATED_HOURLY_ROW_BYTES;

    await recordRun(env, "prune", startedAt, Date.now() - t0, {
      productsSeen: byTag.size,
      rowsWritten: dailyRows.length,
      rowsDeleted: snapshotPrune.deleted + hourlyPrune.deleted,
      dbSizeBytes,
    });
  } catch (e) {
    await recordRun(env, "prune", startedAt, Date.now() - t0, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
