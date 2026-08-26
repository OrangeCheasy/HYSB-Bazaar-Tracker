import type { Span, Tone } from "./types.js";

/**
 * Turn an hours-of-the-day window into shaded ranges on a time axis.
 *
 * The buy and sell windows are recurring — "23:00 to 07:00, every night" — not one range,
 * so a week-long chart carries seven shaded regions rather than one rectangle. Expanding
 * them here keeps `PriceChart` from having to know what a sleep window is; it only ever
 * sees absolute `fromTs`/`toTs` pairs.
 *
 * Wrapping past midnight is the case that makes this non-trivial, and it is the DEFAULT
 * case: the sleep window is 23:00-07:00. A window that wraps produces a span that starts on
 * one day and ends on the next, which is why this walks days rather than mapping them.
 */

const HOUR = 3600;
const DAY = 86_400;

export function dailySpans({
  fromTs,
  toTs,
  startHour,
  endHour,
  tone,
  keyPrefix,
  label,
  utcOffsetHours = 0,
}: {
  /** Chart bounds, UTC epoch seconds. */
  readonly fromTs: number;
  readonly toTs: number;
  /** Hour of the day the window opens and closes, in the VIEWER's zone. */
  readonly startHour: number;
  readonly endHour: number;
  readonly tone: Tone;
  readonly keyPrefix: string;
  readonly label?: string;
  /** The viewer's whole-hour offset from UTC, so the shading lands on their evening. */
  readonly utcOffsetHours?: number;
}): readonly Span[] {
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return [];

  // Length in hours, wrapping through midnight. A window equal to the full day is treated
  // as 24 hours rather than collapsing to zero.
  const rawLength = (((endHour - startHour) % 24) + 24) % 24;
  const lengthHours = rawLength === 0 ? 24 : rawLength;

  const offsetSeconds = utcOffsetHours * HOUR;
  const spans: Span[] = [];

  // Start a day early so a window that opened before the chart's left edge still shades its
  // visible tail.
  const firstDay = Math.floor((fromTs + offsetSeconds) / DAY) * DAY - DAY;
  const lastDay = Math.ceil((toTs + offsetSeconds) / DAY) * DAY;

  for (let day = firstDay; day <= lastDay; day += DAY) {
    const openLocal = day + startHour * HOUR;
    const open = openLocal - offsetSeconds;
    const close = open + lengthHours * HOUR;

    // Clip to the chart rather than dropping: a window straddling either edge is still
    // real, and the part inside the chart is the part worth showing.
    const from = Math.max(open, fromTs);
    const to = Math.min(close, toTs);
    if (to <= from) continue;

    spans.push({ key: `${keyPrefix}-${open}`, fromTs: from, toTs: to, tone, label });
  }

  return spans;
}

/** The hours a window covers, for shading the hour-of-day chart. Wraps past midnight. */
export function windowHours(startHour: number, endHour: number): readonly number[] {
  const rawLength = (((endHour - startHour) % 24) + 24) % 24;
  const length = rawLength === 0 ? 24 : rawLength;
  return Array.from({ length }, (_, i) => (startHour + i) % 24);
}
