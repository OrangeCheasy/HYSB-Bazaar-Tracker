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
  /**
   * How many of the window's hours actually had data. Below `lengthHours` means the
   * score rests on partial evidence — surface it rather than presenting a gap-filled
   * window as though it were solid.
   */
  readonly hoursPresent: number;
}

function hourOf(ts: number): Hour {
  // Non-negative modulo, so pre-1970 timestamps do not produce a negative index.
  const h = ((Math.floor(ts / 3600) % 24) + 24) % 24;
  return h as Hour;
}

export function computeHourProfile(bars: readonly Bar[]): Result<HourProfile, ProfileError> {
  if (bars.length === 0) return err("empty-series");

  // A Map rather than a fixed-length array: indexing an array of 24 yields `Bar[] |
  // undefined`, so the code would carry an impossible-but-uncoverable branch on every
  // push. Both sides of `get` here are real — first bar of an hour, versus a later one.
  const byHour = new Map<number, Bar[]>();
  const days = new Set<number>();

  for (const b of bars) {
    const h = hourOf(b.ts);
    const group = byHour.get(h);
    if (group) group.push(b);
    else byHour.set(h, [b]);

    days.add(Math.floor(b.ts / 86_400));
  }

  // Per-hour means first, then the baseline from those means — NOT from the raw bars.
  // Each populated hour gets one vote regardless of how many samples landed in it, so a
  // densely-sampled hour cannot drag the baseline toward its own price and make every
  // other hour look mispriced. Matters because Coflnet coarsens older history, leaving
  // hours with wildly uneven sample counts.
  const hourMeans: { readonly ask: number; readonly bid: number; readonly samples: number }[] =
    [];
  let askBaseSum = 0;
  let bidBaseSum = 0;
  let populated = 0;

  for (let h = 0; h < 24; h++) {
    const group = byHour.get(h) ?? [];
    const ask = mean(group.map((b) => b.askAvg)) ?? 0;
    const bid = mean(group.map((b) => b.bidAvg)) ?? 0;
    hourMeans.push({ ask, bid, samples: group.length });
    if (group.length > 0) {
      askBaseSum += ask;
      bidBaseSum += bid;
      populated++;
    }
  }

  // `bars` is non-empty, so at least one hour is populated and this cannot divide by zero.
  const askBaseline = askBaseSum / populated;
  const bidBaseline = bidBaseSum / populated;

  const buckets: HourBucket[] = [];
  for (let h = 0; h < 24; h++) {
    const cell = hourMeans[h] ?? { ask: 0, bid: 0, samples: 0 };
    buckets.push({
      hour: h as Hour,
      samples: cell.samples,
      askMean: cell.ask,
      bidMean: cell.bid,
      midMean: (cell.ask + cell.bid) / 2,
      // A zero baseline means a worthless item, not a 100%-cheap hour. Report 0.
      askIndex: askBaseline === 0 ? 0 : cell.ask / askBaseline,
      bidIndex: bidBaseline === 0 ? 0 : cell.bid / bidBaseline,
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
 * returning nothing.
 *
 * A window scores on the hours it actually has, provided at least half of them are
 * populated, and carries `hoursPresent` so a thin result can be marked rather than
 * silently trusted. See ADR-012.
 */
export function bestContiguousWindow(
  profile: HourProfile,
  lengthHours: number,
  objective: "min" | "max",
): HourWindow | undefined {
  if (!Number.isInteger(lengthHours) || lengthHours < 1 || lengthHours > 24) return undefined;

  const index = (b: HourBucket): number => (objective === "min" ? b.bidIndex : b.askIndex);

  // A window scores if at least half its hours have data. Requiring all
  // of them returns nothing at all on coarsened backfill history, where Coflnet gives
  // 2-hour buckets and half the hour slots are legitimately empty. The count travels on
  // the result so a thin window can be marked rather than silently trusted.
  const required = Math.max(1, Math.floor(lengthHours / 2));

  let best: HourWindow | undefined;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    let present = 0;
    for (let k = 0; k < lengthHours; k++) {
      const bucket = profile.buckets[(start + k) % 24];
      if (!bucket || bucket.samples === 0) continue;
      sum += index(bucket);
      present++;
    }
    if (present < required) continue;

    const meanIndex = sum / present;
    const better =
      best === undefined ||
      (objective === "min" ? meanIndex < best.meanIndex : meanIndex > best.meanIndex);
    if (better) {
      best = {
        startHour: start as Hour,
        lengthHours,
        meanIndex,
        wraps: start + lengthHours > 24,
        hoursPresent: present,
      };
    }
  }
  return best;
}

/** Which numeric field of an hour bucket to read. */
export type HourField = "askMean" | "bidMean" | "midMean" | "askIndex" | "bidIndex";

/**
 * Mean of one field across a named set of hours, ignoring hours with no data.
 *
 * Returns `undefined` rather than 0 when none of the requested hours has data, so the
 * caller can fall back to the current book instead of pricing a craft at zero. (model.py
 * returns 0.0 and relies on `or last_bid` at the call site; 0 is a legitimate price for a
 * dead item, so a sentinel that means "no data" must not also be a possible answer.)
 */
export function meanOverHours(
  profile: HourProfile,
  hours: Iterable<number>,
  field: HourField,
): number | undefined {
  let sum = 0;
  let count = 0;
  for (const h of hours) {
    const bucket = profile.buckets[((h % 24) + 24) % 24];
    if (!bucket || bucket.samples === 0) continue;
    sum += bucket[field];
    count++;
  }
  return count === 0 ? undefined : sum / count;
}

/**
 * The hours in a window, inclusive of `startHour` and exclusive of `endHour`, wrapping
 * past midnight. `hourRange(23, 7)` is the default overnight window: 23, 0, 1 … 6.
 *
 * A start equal to the end means the whole day, not an empty window — "23 to 23" is 24
 * hours of unattended orders, which is the reading that matches how people describe it.
 */
export function hourRange(startHour: number, endHour: number): Hour[] {
  const start = ((Math.trunc(startHour) % 24) + 24) % 24;
  const end = ((Math.trunc(endHour) % 24) + 24) % 24;
  const span = start === end ? 24 : ((end - start + 24) % 24) + 0;
  return Array.from({ length: span }, (_, i) => ((start + i) % 24) as Hour);
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
