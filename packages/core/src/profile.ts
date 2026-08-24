import { err, ok, type Result } from "./result.js";
import type { Bar } from "./sides.js";
import { mean } from "./stats.js";

/**
 * Hour-of-day profiling.
 *
 * Buckets are UTC. Epoch 0 is 1970-01-01T00:00:00Z, so the hour is just
 * `floor(ts / 3600) % 24` — no calendar arithmetic, no timezone database, nothing to
 * get wrong. Conversion to the reader's local time happens in the browser
 * (CLAUDE.md section 5).
 */

export type Hour =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23;

export interface HourBucket {
  readonly hour: Hour;
  /** Zero means this hour has no data. Callers must not treat it as a price of zero. */
  readonly samples: number;
  readonly askMean: number;
  readonly bidMean: number;
  readonly midMean: number;
  /** Relative to the 24-hour baseline. 1.0 is average, 0.9 is 10% cheap. */
  readonly askIndex: number;
  readonly bidIndex: number;
}

export interface HourProfile {
  /** Always length 24, in hour order, including hours with no data. */
  readonly buckets: readonly HourBucket[];
  readonly askBaseline: number;
  readonly bidBaseline: number;
  readonly days: number;
  readonly totalSamples: number;
}

export type ProfileError = "empty-series";

export interface HourWindow {
  readonly startHour: Hour;
  readonly lengthHours: number;
  readonly meanIndex: number;
  /** True when the window runs past midnight UTC, e.g. 22:00 to 02:00. */
  readonly wraps: boolean;
}

function hourOf(ts: number): Hour {
  // Non-negative modulo, so pre-1970 timestamps do not produce a negative index.
  const h = ((Math.floor(ts / 3600) % 24) + 24) % 24;
  return h as Hour;
}

export function computeHourProfile(bars: readonly Bar[]): Result<HourProfile, ProfileError> {
  if (bars.length === 0) return err("empty-series");

  const byHour: Bar[][] = Array.from({ length: 24 }, () => []);
  const days = new Set<number>();
  for (const b of bars) {
    byHour[hourOf(b.ts)]?.push(b);
    days.add(Math.floor(b.ts / 86_400));
  }

  const askBaseline = mean(bars.map((b) => b.askAvg)) ?? 0;
  const bidBaseline = mean(bars.map((b) => b.bidAvg)) ?? 0;

  const buckets: HourBucket[] = [];
  for (let h = 0; h < 24; h++) {
    const group = byHour[h] ?? [];
    const askMean = mean(group.map((b) => b.askAvg)) ?? 0;
    const bidMean = mean(group.map((b) => b.bidAvg)) ?? 0;
    buckets.push({
      hour: h as Hour,
      samples: group.length,
      askMean,
      bidMean,
      midMean: (askMean + bidMean) / 2,
      // A zero baseline means a worthless item, not a 100%-cheap hour. Report 0.
      askIndex: askBaseline === 0 ? 0 : askMean / askBaseline,
      bidIndex: bidBaseline === 0 ? 0 : bidMean / bidBaseline,
    });
  }

  return ok({
    buckets,
    askBaseline,
    bidBaseline,
    days: days.size,
    totalSamples: bars.length,
  });
}

/**
 * Best contiguous run of hours, wrapping past midnight when that is genuinely best.
 *
 * The wrap case is the common one: a game server's quiet hours straddle midnight UTC. A
 * search that cannot wrap silently returns the second-best window, which is worse than
 * returning nothing. Windows containing an hour with no data are skipped entirely rather
 * than scored on partial evidence.
 */
export function bestContiguousWindow(
  profile: HourProfile,
  lengthHours: number,
  objective: "min" | "max",
): HourWindow | undefined {
  if (!Number.isInteger(lengthHours) || lengthHours < 1 || lengthHours > 24) return undefined;

  const index = (b: HourBucket): number => (objective === "min" ? b.bidIndex : b.askIndex);

  let best: HourWindow | undefined;
  for (let start = 0; start < 24; start++) {
    const values: number[] = [];
    let complete = true;
    for (let k = 0; k < lengthHours; k++) {
      const bucket = profile.buckets[(start + k) % 24];
      if (!bucket || bucket.samples === 0) {
        complete = false;
        break;
      }
      values.push(index(bucket));
    }
    if (!complete) continue;

    const meanIndex = mean(values) ?? 0;
    const better =
      best === undefined ||
      (objective === "min" ? meanIndex < best.meanIndex : meanIndex > best.meanIndex);
    if (better) {
      best = {
        startHour: start as Hour,
        lengthHours,
        meanIndex,
        wraps: start + lengthHours > 24,
      };
    }
  }
  return best;
}

/**
 * Cheapest run of hours to accumulate base materials in.
 *
 * Scored on the BID index, because materials get accumulated with buy orders, and a buy
 * order competes at the bid.
 */
export function bestBuyWindow(
  profile: HourProfile,
  lengthHours: number,
): HourWindow | undefined {
  return bestContiguousWindow(profile, lengthHours, "min");
}

/**
 * Dearest run of hours to offload product in.
 *
 * Scored on the ASK index, because product gets offloaded with sell offers, and a sell
 * offer competes at the ask.
 */
export function bestSellWindow(
  profile: HourProfile,
  lengthHours: number,
): HourWindow | undefined {
  return bestContiguousWindow(profile, lengthHours, "max");
}
