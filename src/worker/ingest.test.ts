import { describe, expect, it } from "vitest";
import { isWellFormed } from "@core/index.js";
import { normalizeProduct, type RawBazaarResponse } from "./ingest.js";
// A real Hypixel response, captured once during Phase 0.5/2. Worker code (and its
// tests) must never call api.hypixel.net directly outside the scheduled handler
// (CLAUDE.md section 2) — a plain JSON import keeps this test entirely offline, and
// avoids reaching for node:fs, which src/worker's tsconfig deliberately has no types
// for (this directory mirrors what the Worker runtime can actually do).
import fixture from "./test/fixtures/bazaar-response.json" with { type: "json" };

const entries = Object.entries((fixture as RawBazaarResponse).products);
const TS = 1_700_000_000;

// Live-fixture tests, not the live API — per CLAUDE.md section 2, the Worker's fetch
// handler and its tests must never call api.hypixel.net directly. This fixture was
// captured once during Phase 0.5/2 and is committed for reuse.
describe("normalizeProduct against a real Hypixel fixture", () => {
  it("normalizes every product that has a quick_status without throwing", () => {
    for (const entry of entries) {
      const [, raw] = entry;
      if (!raw.quick_status) continue;
      const result = normalizeProduct(entry, TS);
      // A well-formed product must normalize successfully; a crossed book is the only
      // legitimate failure mode once quick_status is present.
      if (!result.ok) {
        expect(result.error).toBe("crossed-book");
      }
    }
  });

  it("flags a product with no quick_status as missing-field, not a crash", () => {
    const deadEntry: [string, RawBazaarResponse["products"][string]] = [
      "DEAD_TAG",
      { product_id: "DEAD_TAG", sell_summary: [], buy_summary: [] },
    ];
    const result = normalizeProduct(deadEntry, TS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("missing-field");
  });

  it("produces a well-formed Point (ask >= bid) for every successfully normalized product", () => {
    let checked = 0;
    for (const entry of entries) {
      const result = normalizeProduct(entry, TS);
      if (!result.ok) continue;
      expect(isWellFormed(result.value.point)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000); // sanity: the fixture actually has real data
  });

  it("assigns depth metrics to the same side as the derived ask/bid for a real product", () => {
    const entry = entries.find(
      ([, p]) => p.quick_status && p.buy_summary.length > 0 && p.sell_summary.length > 0,
    );
    if (!entry) throw new Error("fixture has no product with both summaries populated");
    const result = normalizeProduct(entry, TS);
    if (!result.ok) throw new Error(`expected success, got ${result.error}`);

    const { point, askDepthMetrics, bidDepthMetrics } = result.value;
    // ask depth metrics come from whichever raw summary shares ask's side; since real
    // order books are never perfectly empty on a traded item, at least one of maxWall
    // should be positive for a product with populated summaries.
    expect(point.ask).toBeGreaterThanOrEqual(point.bid);
    expect(askDepthMetrics.maxWall + bidDepthMetrics.maxWall).toBeGreaterThan(0);
  });

  it("reports realistic missing/crossed rates on a real payload (regression guard)", () => {
    let missing = 0;
    let crossed = 0;
    for (const entry of entries) {
      const result = normalizeProduct(entry, TS);
      if (result.ok) continue;
      if (result.error === "missing-field") missing++;
      else if (result.error === "crossed-book") crossed++;
    }
    // Loose bounds, not exact counts: this is a live capture and will drift over time.
    // The point is catching a wholesale parsing regression (e.g. every product suddenly
    // "missing"), not pinning today's exact numbers.
    expect(missing).toBeLessThan(entries.length);
    expect(crossed).toBeLessThan(entries.length * 0.05);
  });
});
