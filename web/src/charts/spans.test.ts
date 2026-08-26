import { describe, expect, it } from "vitest";
import { dailySpans, windowHours } from "./spans.js";

/**
 * The hours-of-the-day to absolute-ranges expansion.
 *
 * Worth testing away from the chart because the default case wraps past midnight — the
 * sleep window is 23:00 to 07:00 — and a shaded region on the wrong side of midnight would
 * look plausible while telling a user their orders rest during the wrong eight hours.
 */

const HOUR = 3600;
const DAY = 86_400;

/** 2026-08-24 00:00:00 UTC, a Monday, on a day boundary so arithmetic reads clearly. */
const MONDAY = 1_787_270_400 - (1_787_270_400 % DAY);

describe("dailySpans", () => {
  it("emits one span per day, not one for the whole chart", () => {
    const spans = dailySpans({
      fromTs: MONDAY,
      toTs: MONDAY + 7 * DAY,
      startHour: 9,
      endHour: 17,
      tone: "buy",
      keyPrefix: "buy",
    });
    // Seven days, each with a 09:00-17:00 window fully inside the range.
    expect(spans.length).toBeGreaterThanOrEqual(7);
    for (const span of spans) {
      expect(span.toTs - span.fromTs).toBeLessThanOrEqual(8 * HOUR);
    }
  });

  it("wraps a window that runs past midnight, which is the default case", () => {
    const spans = dailySpans({
      fromTs: MONDAY,
      toTs: MONDAY + 2 * DAY,
      startHour: 23,
      endHour: 7,
      tone: "buy",
      keyPrefix: "buy",
    });
    // 23:00 to 07:00 is eight hours, not sixteen and not negative.
    const full = spans.filter((s) => s.toTs - s.fromTs === 8 * HOUR);
    expect(full.length).toBeGreaterThan(0);
  });

  it("shifts the window into the viewer's zone", () => {
    // Someone in UTC+2 sleeping 23:00 local is resting orders from 21:00 UTC.
    const spans = dailySpans({
      fromTs: MONDAY,
      toTs: MONDAY + DAY,
      startHour: 23,
      endHour: 7,
      tone: "buy",
      keyPrefix: "buy",
      utcOffsetHours: 2,
    });
    const opening = spans.find((s) => s.fromTs > MONDAY && s.fromTs < MONDAY + DAY);
    expect(opening).toBeDefined();
    expect(((opening!.fromTs % DAY) + DAY) % DAY).toBe(21 * HOUR);
  });

  it("clips to the chart instead of dropping a window that straddles an edge", () => {
    // The chart starts mid-window: the visible tail is still real and still worth shading.
    const spans = dailySpans({
      fromTs: MONDAY + 2 * HOUR,
      toTs: MONDAY + 12 * HOUR,
      startHour: 0,
      endHour: 8,
      tone: "buy",
      keyPrefix: "buy",
    });
    const first = spans[0];
    expect(first).toBeDefined();
    expect(first!.fromTs).toBe(MONDAY + 2 * HOUR);
    expect(first!.toTs).toBe(MONDAY + 8 * HOUR);
  });

  it("never emits a span outside the chart bounds", () => {
    const from = MONDAY;
    const to = MONDAY + 3 * DAY;
    for (const span of dailySpans({
      fromTs: from,
      toTs: to,
      startHour: 23,
      endHour: 7,
      tone: "buy",
      keyPrefix: "buy",
    })) {
      expect(span.fromTs).toBeGreaterThanOrEqual(from);
      expect(span.toTs).toBeLessThanOrEqual(to);
      expect(span.toTs).toBeGreaterThan(span.fromTs);
    }
  });

  it("returns nothing for an empty or inverted range rather than looping", () => {
    expect(
      dailySpans({
        fromTs: 100,
        toTs: 100,
        startHour: 1,
        endHour: 2,
        tone: "buy",
        keyPrefix: "b",
      }),
    ).toEqual([]);
    expect(
      dailySpans({
        fromTs: 500,
        toTs: 100,
        startHour: 1,
        endHour: 2,
        tone: "buy",
        keyPrefix: "b",
      }),
    ).toEqual([]);
  });

  it("treats a start equal to the end as a full day, not a zero-width span", () => {
    const spans = dailySpans({
      fromTs: MONDAY,
      toTs: MONDAY + DAY,
      startHour: 0,
      endHour: 0,
      tone: "buy",
      keyPrefix: "buy",
    });
    expect(spans.length).toBeGreaterThan(0);
    expect(Math.max(...spans.map((s) => s.toTs - s.fromTs))).toBe(DAY);
  });
});

describe("windowHours", () => {
  it("lists the hours a window covers", () => {
    expect(windowHours(9, 12)).toEqual([9, 10, 11]);
  });

  it("wraps past midnight", () => {
    expect(windowHours(23, 7)).toEqual([23, 0, 1, 2, 3, 4, 5, 6]);
  });

  it("covers the whole day when start equals end", () => {
    expect(windowHours(5, 5)).toHaveLength(24);
  });
});
