import type { BandHitRate } from "@core/index.js";
import { formatCoins } from "../format.js";

/**
 * A band price and its hit-rate — as ONE component emitting TWO cells.
 *
 * CLAUDE.md §7.6 and ROADMAP Phase 5 both say a band never appears without its hit-rate
 * adjacent, and not in a tooltip. Making that a rule someone has to remember is how it
 * breaks six months from now. Making it a component that emits both cells means there is
 * no way to put a band on screen without its hit-rate: this is the only thing in the app
 * that renders a band, and it cannot render one alone.
 *
 * It emits two `<td>`s rather than one so the desktop table keeps a real column grid —
 * every row's rate lines up in the same column, which is what makes a table of 200 rows
 * scannable. On mobile the grid places the rate directly beneath its band instead. Same
 * markup, same guarantee, CSS does the rearranging.
 *
 * Why it matters: a p10 buy order sits unfilled ~90% of the time BY CONSTRUCTION. The band
 * is only a trade if price actually visits it, and this is the only thing on the row that
 * says whether it did.
 */

/** Below this, an order at this band essentially never filled in the window. It drives
 *  emphasis, not filtering — a cold band is information, not an error. */
const COLD_RATE = 0.05;

export function BandCells({
  price,
  hits,
  side,
}: {
  readonly price: number;
  readonly hits: BandHitRate;
  readonly side: "buy" | "sell";
}): React.JSX.Element {
  const pct = Math.round(hits.rate * 100);
  const cold = hits.rate < COLD_RATE;
  const detail = `${hits.hoursTouched} of ${hits.hoursTotal} hours touched this ${side} band`;

  return (
    <>
      <td
        role="cell"
        className="num px-2 py-1 text-left text-ink sm:text-right"
        style={{ gridArea: side === "buy" ? "buy" : "sell" }}
      >
        {/* The side is spelled out on mobile, where the column headers are gone. On
            desktop the header says it once for the whole column instead. */}
        <span className="mr-1 text-[11px] text-ink-faint sm:hidden">{side}</span>
        {formatCoins(price)}
      </td>
      <td
        role="cell"
        className={`num px-2 py-1 text-right text-xs ${cold ? "text-outage" : "text-ink-dim"}`}
        style={{ gridArea: side === "buy" ? "buyfill" : "sellfill" }}
        title={detail}
      >
        {pct}%
      </td>
    </>
  );
}
