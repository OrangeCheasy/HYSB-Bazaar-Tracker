import type { ScanRow, ScenarioResult } from "@core/index.js";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ScanTable } from "./ScanTable.js";
import { DEFAULT_SCAN_SORT } from "./rank.js";

/**
 * Markup tests for the craft scan, asserting the two non-negotiables in the emitted HTML
 * rather than in the component that happens to produce it today:
 *
 *   - a margin never renders without its fill feasibility adjacent, and not in a tooltip
 *   - unverified recipes are visually marked
 *
 * The second is load-bearing on launch rather than rare: every compaction ratio and every
 * anvil edge ships unverified.
 */

function scenario(over: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    kind: "timed",
    baseUnitPrice: 5.6,
    productUnitPrice: 896,
    costPerCraft: 896,
    grossPerCraft: 884,
    taxPerCraft: 11,
    profitPerCraft: -11,
    // A FRACTION here — WeeklyBand.spreadPct is percentage points. Same name, one file
    // apart in core, opposite units.
    marginPct: -0.0127,
    fillFeasibility: 0.8,
    ...over,
  };
}

function fixture(over: Partial<ScanRow> = {}): ScanRow {
  const recipe = {
    id: 2,
    baseTag: "COAL",
    enchTag: "ENCHANTED_COAL",
    ratio: 160,
    verified: false,
    note: null,
  };
  return {
    recipe,
    kind: "compact",
    analysis: {
      recipe,
      scenarios: { floor: scenario(), orders: scenario(), timed: scenario() },
      throughput: {
        baseUnitsPerDay: 2_600_000,
        productUnitsPerDay: 68_571,
        craftsFromSupply: 16_250,
        craftsFromDemand: 68_571,
        craftsPerDay: 16_250,
        limitedBy: "base-supply",
        hoursToFillOneCraft: 0.0015,
      },
      profitPerDay: -2_113_457,
      capitalPerCraft: 1_007,
      capitalRequired: 16_379_375,
      flags: ["unverified-recipe"],
    },
    ...over,
  };
}

function render(rows: readonly ScanRow[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ScanTable rows={rows} sort={DEFAULT_SCAN_SORT} onSortChange={() => {}} />
    </MemoryRouter>,
  );
}

function cells(html: string): string[] {
  // `<tbody` without the closing bracket: the element carries classes now.
  const body = html.slice(html.indexOf("<tbody"));
  return [...body.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]*>/g, "").trim(),
  );
}

function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("a margin never renders alone", () => {
  it("puts the fill feasibility in the cell immediately after the margin", () => {
    const values = cells(render([fixture()]));
    const marginIndex = values.indexOf("-1.3%");
    expect(marginIndex).toBeGreaterThan(-1);
    expect(values[marginIndex + 1]).toBe("80%");
  });

  it("renders the fill figure as text, not only as a title attribute", () => {
    expect(text(render([fixture()]))).toContain("80%");
  });

  it("holds for the case that most needs it: a huge margin nobody can fill", () => {
    // A real seeded anvil row: 113% margin against a fill feasibility of 0.0003%. The
    // margin alone reads as free money; the number beside it is the whole story.
    const values = cells(
      render([
        fixture({
          kind: "anvil",
          analysis: {
            ...fixture().analysis!,
            scenarios: {
              floor: scenario(),
              orders: scenario(),
              timed: scenario({ marginPct: 1.1343, fillFeasibility: 0.0000034 }),
            },
          },
        }),
      ]),
    );
    const marginIndex = values.indexOf("113.4%");
    expect(marginIndex).toBeGreaterThan(-1);
    expect(values[marginIndex + 1]).toBe("0%");
  });

  it("shows no margin at all rather than a bare one when a row has no analysis", () => {
    const html = render([fixture({ analysis: undefined, error: "no-base-data" })]);
    expect(cells(html)).not.toContain("-1.3%");
  });

  it("explains an unscored row in words, never as the internal error code", () => {
    // `no-base-data` is a variable name. It must not reach a reader, in the cell or in the
    // tooltip — the explanation is what tells them the row is fine and just waiting.
    const html = render([fixture({ analysis: undefined, error: "no-base-data" })]);
    expect(html).not.toContain("no-base-data");
    expect(html).toContain("No price history has been collected for the base material yet");
  });
});

describe("unverified recipes are marked", () => {
  it("marks an unverified row visibly, not only in a tooltip", () => {
    const html = render([fixture()]);
    // The marker survives stripping every attribute, so it is not tooltip-only.
    expect(text(html)).toContain("?");
    expect(html).toContain("underline decoration-dotted");
  });

  it("says in the accessible name what the marker means", () => {
    expect(render([fixture()])).toContain('aria-label="unverified ratio"');
  });

  it("leaves a verified recipe unmarked, so the marking still means something", () => {
    const verified = fixture();
    const html = render([{ ...verified, recipe: { ...verified.recipe, verified: true } }]);
    expect(html).not.toContain("underline decoration-dotted");
    expect(html).not.toContain('aria-label="unverified ratio"');
  });
});

describe("craft type is a visible column", () => {
  it("renders the kind as text in its own cell", () => {
    expect(cells(render([fixture()]))).toContain("compact");
    expect(cells(render([fixture({ kind: "anvil" })]))).toContain("anvil");
  });
});

describe("units", () => {
  it("reads ScenarioResult.marginPct as a fraction", () => {
    // -0.0127 is -1.3%. Treating it as percentage points would print "-0.0%" and treating
    // a band's percentage points as a fraction prints "1047.8%" — the same trap, mirrored.
    expect(text(render([fixture()]))).toContain("-1.3%");
    expect(text(render([fixture()]))).not.toContain("-0.0%");
  });
});

describe("mobile reflow", () => {
  it("keeps table semantics when the row becomes a grid", () => {
    const html = render([fixture()]);
    expect(html).toContain('role="table"');
    expect(html).toContain('role="row"');
    expect(html).toContain('role="cell"');
  });

  it("keeps the margin and its fill in adjacent grid areas on a phone", () => {
    const html = render([fixture()]);
    for (const area of ["name", "type", "margin", "fill", "profit", "crafts"]) {
      expect(html).toContain(`grid-area:${area}`);
    }
  });
});
