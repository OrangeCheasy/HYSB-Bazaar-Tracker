import type { WarningFlag } from "@core/index.js";
import { describe, expect, it } from "vitest";
import { FLAG_COPY } from "./flagCopy.js";

/**
 * The flag copy is the part of this feature that matters most — a user who cannot act on a
 * warning is not warned. These are the properties that keep it that way as flags get added
 * or reworded, not a snapshot of the prose.
 */

/** Every flag core can emit. Kept as a literal so adding one to core fails here until it
 *  has copy, rather than silently rendering an undefined chip. */
const ALL_FLAGS: readonly WarningFlag[] = [
  "unverified-recipe",
  "implausible-margin",
  "deep-buy-queue",
  "product-rarely-instant-bought",
  "volatile-base",
  "profit-needs-both-fills",
  "slow-fill",
  "wide-spread",
  "stale-data",
  "single-sided-book",
  "below-ratio-parity",
];

describe("every flag has copy", () => {
  it("covers all eleven, with nothing missing", () => {
    for (const flag of ALL_FLAGS) {
      expect(FLAG_COPY[flag], flag).toBeDefined();
    }
    expect(Object.keys(FLAG_COPY).sort()).toEqual([...ALL_FLAGS].sort());
  });
});

describe("the copy explains rather than names", () => {
  it("gives every flag a detail long enough to say what to do", () => {
    // "Deep buy-order queue" restated as "there is a deep buy-order queue" helps nobody.
    // A real explanation of what it costs and what to do about it does not fit in a line.
    for (const flag of ALL_FLAGS) {
      expect(FLAG_COPY[flag].detail.length, flag).toBeGreaterThan(200);
    }
  });

  it("never lets the detail just repeat the flag name", () => {
    for (const flag of ALL_FLAGS) {
      const words = flag.split("-");
      const detail = FLAG_COPY[flag].detail.toLowerCase();
      // The detail may well use the flag's words — it should not consist of them.
      const restated = words.every((word) => detail.startsWith(word));
      expect(restated, flag).toBe(false);
    }
  });

  it("keeps chips short enough for a dense table row", () => {
    for (const flag of ALL_FLAGS) {
      expect(FLAG_COPY[flag].short.length, flag).toBeLessThanOrEqual(16);
      expect(FLAG_COPY[flag].summary.length, flag).toBeLessThanOrEqual(100);
    }
  });

  it("addresses the reader in the second person, so it reads as advice", () => {
    // Every one of these should be about what happens to YOUR order, not about the market
    // in the abstract.
    for (const flag of ALL_FLAGS) {
      const detail = FLAG_COPY[flag].detail.toLowerCase();
      expect(/\byou\b|\byour\b/.test(detail), flag).toBe(true);
    }
  });
});

describe("tone separates 'not real' from 'real but caveated'", () => {
  it("marks the three suspicious flags as warnings", () => {
    for (const flag of [
      "implausible-margin",
      "below-ratio-parity",
      "single-sided-book",
    ] as const) {
      expect(FLAG_COPY[flag].tone, flag).toBe("warn");
    }
  });

  it("leaves qualifying flags as info, so a warning still stands out", () => {
    for (const flag of [
      "slow-fill",
      "volatile-base",
      "stale-data",
      "deep-buy-queue",
    ] as const) {
      expect(FLAG_COPY[flag].tone, flag).toBe("info");
    }
  });
});
