import { describe, expect, it } from "vitest";
import { chunkByParamCount } from "./chunk.js";

describe("chunkByParamCount", () => {
  it("returns an empty array for empty input", () => {
    expect(chunkByParamCount([], 11)).toEqual([]);
  });

  it("puts everything in one chunk when it fits under the cap", () => {
    const rows = [1, 2, 3];
    expect(chunkByParamCount(rows, 11)).toEqual([[1, 2, 3]]);
  });

  it("splits into floor(maxParams / paramsPerRow)-sized chunks", () => {
    // 11 params/row, cap 100 -> 9 rows/chunk
    const rows = Array.from({ length: 20 }, (_, i) => i);
    const chunks = chunkByParamCount(rows, 11);
    expect(chunks.map((c) => c.length)).toEqual([9, 9, 2]);
  });

  it("honors a custom maxParams", () => {
    const rows = Array.from({ length: 5 }, (_, i) => i);
    expect(chunkByParamCount(rows, 3, 10)).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });

  it("never produces a zero-row chunk even if paramsPerRow exceeds maxParams", () => {
    const rows = [1, 2, 3];
    const chunks = chunkByParamCount(rows, 200, 100);
    expect(chunks).toEqual([[1], [2], [3]]);
  });

  it("throws on a non-positive paramsPerRow rather than dividing by zero", () => {
    expect(() => chunkByParamCount([1], 0)).toThrow();
    expect(() => chunkByParamCount([1], -1)).toThrow();
  });
});
