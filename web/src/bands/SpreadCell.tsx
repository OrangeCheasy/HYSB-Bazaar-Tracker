import type { WeeklyBand } from "@core/index.js";
import { formatPercentPoints } from "../format.js";

/**
 * The spread, and the fill-feasibility figure that is not allowed to leave its side.
 *
 * The spread is this view's margin number, so CLAUDE.md §7.6 applies: a margin never
 * renders alone. For a band strategy the companion is `bothHitWeeks` — how many weeks BOTH
 * bands were touched — because the profit is conditional on two orders filling, not one.
 * A 6% spread where both sides filled in 0 of 4 weeks is not a 6% trade.
 *
 * Same construction as BandCells: two cells from one component, so the spread cannot be
 * rendered without its companion.
 *
 * `weekCount` renders inline whenever it is under four. ROADMAP Phase 5: anything resting
 * on fewer than 4 weeks says so where the number is, not in a footnote. Four is the
 * ceiling the 30-day retention cap allows, so "2 of 4" is a full-history claim and "1 of 1"
 * is a single week wearing the same shape.
 */

/** The most weeks the 30-day window can contain (ADR-021). */
const FULL_HISTORY_WEEKS = 4;

export function SpreadCells({ band }: { readonly band: WeeklyBand }): React.JSX.Element {
  const short = band.weekCount < FULL_HISTORY_WEEKS;
  const never = band.bothHitWeeks === 0;

  return (
    <>
      <td
        role="cell"
        className="num px-2 py-1 text-right text-ink"
        style={{ gridArea: "spread" }}
      >
        {formatPercentPoints(band.spreadPct)}
      </td>
      <td
        role="cell"
        className={`num px-2 py-1 text-right text-xs ${never ? "text-outage" : "text-ink-dim"}`}
        style={{ gridArea: "both" }}
        title={
          never
            ? "Neither week saw both bands touched — this spread is a chart annotation, not a trade"
            : `Both bands were touched in ${band.bothHitWeeks} of ${band.weekCount} weeks`
        }
      >
        {band.bothHitWeeks}/{band.weekCount}
        {/* Inline, not a footnote: a "2/2 weeks" that looks perfect is resting on two
            weeks of data, and that has to be legible at the number itself. */}
        {short && <span className="ml-1 text-late">n={band.weekCount}w</span>}
      </td>
    </>
  );
}
