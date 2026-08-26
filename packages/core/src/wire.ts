/**
 * The shape of what `/api/*` returns, declared once.
 *
 * These are plain types with no platform imports — exactly what core is for
 * (CLAUDE.md section 4) — and living here is what stops the Worker and the web app from
 * holding two hand-written copies of the same contract. `web/` cannot import from
 * `src/worker/`, so the alternative was duplication that drifts silently the first time
 * a field is added on one side only.
 *
 * Nothing here computes. The Worker's row builders `satisfies` these; the client parses
 * into them.
 */

import type { BandEconomics, WeeklyBand } from "./bands.js";
import type { ConversionPlan } from "./convert.js";
import type { CraftAnalysis } from "./economics.js";
import type { HourProfile } from "./profile.js";
import type { Recipe, RecipeKind } from "./recipes.js";
import type { Stats } from "./stats.js";

/**
 * Every payload states how old it is — users making trades on 40-minute-old data need to
 * know that (CLAUDE.md section 5).
 *
 * A client must NEVER regenerate this. The KV-backed routes serve their stored meta
 * verbatim precisely so that a stopped cron shows a `staleAfter` in the past; refreshing
 * it on read would erase the only evidence that ingestion has died.
 */
export interface Meta {
  /** UTC epoch seconds the underlying data was generated. */
  readonly generatedAt: number;
  /** UTC epoch seconds after which this payload should be considered stale. */
  readonly staleAfter: number;
  readonly source: "kv" | "d1" | "worker";
}

export interface Envelope<T> {
  readonly data: T;
  readonly meta: Meta;
}

/** Errors are an envelope too, with a real meta block — not a bare status code. The
 *  `error` string names the offending parameter and is written to be shown as-is. */
export interface ErrorEnvelope {
  readonly data: null;
  readonly error: string;
  readonly meta: Meta;
}

/** GET /api/health */
export interface HealthPayload {
  readonly ok: boolean;
  readonly environment: string;
}

/** One row of the ranked craft list. Compaction and anvil share this list because they
 *  compete for the same capital (CLAUDE.md section 8), so `kind` is a visible column
 *  rather than an inferred detail. A row with no `analysis` is kept and reported: "no
 *  data yet" is information, not a reason to vanish. */
export interface ScanRow {
  readonly recipe: Recipe;
  readonly analysis?: CraftAnalysis;
  readonly error?: string;
  readonly kind: RecipeKind;
  /** Anvil only: the chosen route, carrying the entry rung and what it cost. */
  readonly plan?: ConversionPlan;
}

/** GET /api/craft/:baseTag — one entry per recipe keyed on that base tag. */
export interface CraftRow {
  readonly recipe: Recipe;
  readonly analysis?: CraftAnalysis;
  readonly error?: string;
}

/** GET /api/bands — one row per tag, ranked. */
export interface BandScanRow {
  readonly tag: string;
  readonly band: WeeklyBand;
  readonly economics: BandEconomics;
}

/** GET /api/bands/:tag */
export type BandPayload = WeeklyBand & { readonly tag: string };

export type StatsWindow = "1d" | "7d" | "30d";

/** GET /api/item/:tag — a window is null when it could not be computed, never 0. */
export interface ItemStatsPayload {
  readonly tag: string;
  readonly windows: Readonly<Record<StatsWindow, Stats | null>>;
}

/** GET /api/item/:tag/history — display data, shaped by SQL aliases, no core math. */
export interface ChartPoint {
  readonly ts: number;
  readonly askAvg: number;
  readonly askMin: number;
  readonly askMax: number;
  readonly bidAvg: number;
  readonly bidMin: number;
  readonly bidMax: number;
  readonly samples: number;
}

/** GET /api/item/:tag/hours */
export type HourProfilePayload = HourProfile;

/** GET /api/recipes */
export type RecipesPayload = readonly Recipe[];

export type RunKind = "ingest" | "rollup" | "prune" | "precompute";

export interface RunStatus {
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly ok: boolean;
  readonly error: string | null;
}

export interface RowCounts {
  readonly products: number;
  readonly snapshots: number;
  readonly hourly: number;
  readonly daily: number;
  readonly recipes: number;
}

/**
 * GET /api/status — public, because data freshness is a feature, not a secret
 * (CLAUDE.md section 3b).
 *
 * `dataAgeSeconds` is measured from the last SUCCESSFUL ingest, not the latest attempt:
 * a cron failing every five minutes always has a "recent" attempt while no new data has
 * landed. Null means no successful ingest is on record at all.
 */
export interface StatusPayload {
  readonly lastIngestAt: number | null;
  readonly dataAgeSeconds: number | null;
  readonly rowCounts: RowCounts;
  readonly runs: Readonly<Record<RunKind, RunStatus | null>>;
}
