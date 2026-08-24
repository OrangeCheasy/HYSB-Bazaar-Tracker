import type { Bar, Point } from "../src/sides.js";

/** A deterministic hourly bar. Override only what a test actually cares about. */
export function makeBar(over: Partial<Bar> = {}): Bar {
  return {
    ts: 0,
    intervalSeconds: 3600,
    askAvg: 10,
    askMin: 10,
    askMax: 10,
    bidAvg: 9,
    bidMin: 9,
    bidMax: 9,
    askDepth: 1000,
    bidDepth: 1000,
    ibWeek: 7000,
    isWeek: 7000,
    samples: 12,
    source: "hypixel",
    ...over,
  };
}

export function makePoint(over: Partial<Point> = {}): Point {
  return {
    ts: 0,
    ask: 10,
    bid: 9,
    askDepth: 1000,
    bidDepth: 1000,
    ibWeek: 7000,
    isWeek: 7000,
    ...over,
  };
}

/** n consecutive hourly bars starting at startTs, all identical apart from ts. */
export function constantSeries(n: number, over: Partial<Bar> = {}, startTs = 0): Bar[] {
  return Array.from({ length: n }, (_, i) => makeBar({ ...over, ts: startTs + i * 3600 }));
}

/**
 * Deterministic PRNG. packages/core may import nothing but vitest, so there is no
 * fast-check here — this is the property-test generator.
 */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
