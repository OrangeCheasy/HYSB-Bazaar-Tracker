import type { BandScanRow } from "@core/index.js";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { BandTable } from "./BandTable.js";
import { DEFAULT_SORT } from "./sort.js";

/**
 * Markup tests for the band table.
 *
 * `renderToStaticMarkup` rather than testing-library and jsdom: the questions worth asking
 * here are about the emitted HTML — is the hit-rate in the cell next to its band, is the
 * spread a percentage rather than a hundredfold of one — and none of them need a DOM,
 * an event loop, or a browser.
 *
 * The first test is the important one. CLAUDE.md §7.6 says a band never renders without
 * its hit-rate adjacent, and that promise is currently kept by BandCells emitting both
 * cells together. This asserts the promise rather than the mechanism, so it keeps holding
 * if someone later rewrites how the cells are produced.
 */

function fixture(over: Partial<BandScanRow> = {}): BandScanRow {
  return {
    tag: "ENCHANTED_SUGAR_CANE",
    band: {
      buyBand: 1_165_327.36,
      sellBand: 1_287_434.36,
      spread: 122_107,
      // Already percentage points at the source, NOT a fraction — see formatPercentPoints.
      spreadPct: 10.478,
      buyHits: { hoursTouched: 58, hoursTotal: 168, rate: 0.345 },
      sellHits: { hoursTouched: 45, hoursTotal: 168, rate: 0.268 },
      bothHitWeeks: 1,
      weekCount: 1,
      flags: ["short-history"],
    },
    economics: {
      grossPerUnit: 122_107,
      taxPerUnit: 16_092,
      netPerUnit: 106_014,
      capitalPerUnit: 1_165_327,
      profitPerDay: 33_264_619,
      throughput: { marketUnitsPerDay: 5857, unitsPerDay: 313, limitedBy: "sell-side-flow" },
      marginPct: 9.09,
    },
    ...over,
  };
}

function render(rows: readonly BandScanRow[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <BandTable rows={rows} sort={DEFAULT_SORT} onSortChange={() => {}} />
    </MemoryRouter>,
  );
}

/** Cell contents in document order, tags stripped. */
function cells(html: string): string[] {
  // `<tbody` without the closing bracket: the element carries classes now.
  const body = html.slice(html.indexOf("<tbody"));
  return [...body.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]*>/g, "").trim(),
  );
}

describe("the hit-rate is adjacent to its band, always", () => {
  it("puts each fill rate in the cell immediately after its band", () => {
    const values = cells(render([fixture()]));
    // tag, buy, buyfill, sell, sellfill, spread, both, profit, capital
    const buyIndex = values.findIndex((v) => v.includes("1.17M"));
    expect(buyIndex).toBeGreaterThan(-1);
    expect(values[buyIndex + 1]).toBe("35%");

    const sellIndex = values.findIndex((v) => v.includes("1.29M"));
    expect(values[sellIndex + 1]).toBe("27%");
  });

  it("renders the rate as text, not only as a title attribute", () => {
    // A tooltip is explicitly not good enough (ROADMAP Phase 5). Strip every attribute
    // and the rates must survive.
    const textOnly = render([fixture()]).replace(/<[^>]*>/g, " ");
    expect(textOnly).toContain("35%");
    expect(textOnly).toContain("27%");
  });

  it("emits exactly one fill rate per band, for every row", () => {
    const rows = [fixture(), fixture({ tag: "COAL" }), fixture({ tag: "ENCHANTED_COAL" })];
    const html = render(rows);
    // Two hit-rate cells per row carry the hours detail in their title.
    expect([...html.matchAll(/hours touched this (buy|sell) band/g)]).toHaveLength(
      rows.length * 2,
    );
  });
});

describe("the spread carries its fill feasibility", () => {
  it("renders percentage points as given, not multiplied again", () => {
    // The trap: 10.478 is already a percentage. Formatting it as a fraction prints
    // "1047.8%", which reads as a spectacular find rather than a units error.
    const textOnly = render([fixture()]).replace(/<[^>]*>/g, " ");
    expect(textOnly).toContain("10.5%");
    expect(textOnly).not.toContain("1047");
  });

  it("puts both-hit weeks in the cell immediately after the spread", () => {
    const values = cells(render([fixture()]));
    const spreadIndex = values.indexOf("10.5%");
    expect(spreadIndex).toBeGreaterThan(-1);
    expect(values[spreadIndex + 1]).toContain("1/1");
  });
});

describe("small n is inline", () => {
  it("states the week count on a row resting on fewer than four weeks", () => {
    const textOnly = render([fixture()]).replace(/<[^>]*>/g, " ");
    expect(textOnly).toContain("n=1w");
  });

  it("says nothing extra once a row has the full four weeks", () => {
    const full = fixture({
      band: { ...fixture().band, weekCount: 4, bothHitWeeks: 3, flags: [] },
    });
    const textOnly = render([full]).replace(/<[^>]*>/g, " ");
    expect(textOnly).toContain("3/4");
    expect(textOnly).not.toContain("n=");
  });
});

describe("mobile reflow", () => {
  it("keeps table semantics when the row becomes a grid", () => {
    // Changing `display` on tr/td drops their implicit ARIA roles in every browser, which
    // would silently stop this being announced as a table at exactly the width where it is
    // hardest to read. The explicit roles are what put them back.
    const html = render([fixture()]);
    expect(html).toContain('role="table"');
    expect(html).toContain('role="row"');
    expect(html).toContain('role="cell"');
  });

  it("places every visible mobile cell in a named grid area", () => {
    const html = render([fixture()]);
    for (const area of ["tag", "buy", "buyfill", "sell", "sellfill", "spread", "both"]) {
      expect(html).toContain(`grid-area:${area}`);
    }
  });
});
