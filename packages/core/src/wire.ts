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

/**
 * One rung of an enchant family, priced as an entry point into the merge chain.
 *
 * The entry-level search is the whole feature of the anvil solver (CLAUDE.md §8:
 * `min over L < M of (2^(M-L) × price(L))`), and buying 16 level-3 books is frequently
 * cheaper than 64 level-1 books. Returning only the winner asserts the choice; returning
 * the ladder lets a reader check it, which is the difference between a recommendation and
 * a black box.
 */
export interface EntryRung {
  readonly tag: string;
  readonly level: number;
  /** Market ask for one book at this rung. Null when the rung is unpriced — a real state
   *  for thin intermediate levels, and NOT the same as free. */
  readonly price: number | null;
  /** `2^(target - level)` books of this rung per one finished book. */
  readonly unitsRequired: number;
  /** `price × unitsRequired`, or null when the rung is unpriced. */
  readonly totalCost: number | null;
  /** True for the rung the solver actually chose. */
  readonly chosen: boolean;
  /** Set when this rung cannot be merged upward — the market says the conversion does not
   *  exist (ADR-025), so its apparent cost is not reachable. */
  readonly gatedAbove?: boolean;
}

/** GET /api/craft/:tag — one entry per recipe on that tag. */
export interface CraftRow {
  readonly recipe: Recipe;
  readonly analysis?: CraftAnalysis;
  readonly error?: string;
  /** Which craft type this row describes. Absent on rows from before this field existed. */
  readonly kind?: RecipeKind;
  /** Anvil only: the route the solver chose, with its steps. */
  readonly plan?: ConversionPlan;
  /** Anvil only: every rung below the target, priced. The chosen one is marked. */
  readonly ladder?: readonly EntryRung[];
}

/** One row of the ranked band scan. */
export interface BandScanRow {
  readonly tag: string;
  readonly band: WeeklyBand;
  readonly economics: BandEconomics;
}

/**
 * GET /api/bands — the ranked rows, plus why the tags that are missing are missing.
 *
 * `skipped` counts tags that had hourly rows but could not produce a band, keyed by
 * reason. It is part of the answer rather than diagnostics: for the first month of this
 * site's life the honest response to "where are the bands" is "793 tags are still short of
 * the 24 hourly rows a band needs", and an empty list with no explanation cannot say that.
 * A view rendering an empty table has no other way to tell "nothing qualifies yet" from
 * "something is broken".
 */
export interface BandScanPayload {
  readonly rows: readonly BandScanRow[];
  readonly skipped: Readonly<Record<string, number>>;
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

/**
 * GET /api/products — the catalogue, for the item index.
 *
 * `tier` is on the wire because it changes what a detail page can show: Tier A tags keep
 * five-minute snapshots, Tier B only hourly (CLAUDE.md §2), so a Tier B chart is coarser
 * through no fault of the item. A reader should learn that before clicking, not after.
 */
export interface ProductSummary {
  readonly tag: string;
  readonly tier: "A" | "B";
  readonly isEnchanted: boolean;
  readonly firstSeen: number;
  readonly lastSeen: number;
}

export type ProductsPayload = readonly ProductSummary[];
