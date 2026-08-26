import type { ConversionPlan, EntryRung } from "@core/index.js";
import { formatCoins } from "../format.js";
import { displayTag } from "../tagName.js";

/**
 * Which rung to enter a merge chain at, and what the alternatives would have cost.
 *
 * This is the anvil solver's whole reason to exist. Reaching level M from level L takes
 * `2^(M-L)` books, so entering low buys cheap books in bulk and entering high buys few
 * expensive ones — and which wins is not predictable from the ratio, it depends on how the
 * market has priced each rung. Buying 16 level-3 books is frequently cheaper than 64
 * level-1 books.
 *
 * Showing only the winner asserts the choice. Showing the ladder lets a reader check it,
 * and — more usefully — see how close the runner-up was, which is the difference between a
 * decision worth acting on and a coin flip.
 */
export function EntryLadder({
  ladder,
  plan,
}: {
  readonly ladder: readonly EntryRung[];
  readonly plan: ConversionPlan;
}): React.JSX.Element {
  const chosen = ladder.find((rung) => rung.chosen);
  const priced = ladder.filter((rung) => rung.totalCost !== null);
  const runnerUp = priced
    .filter((rung) => !rung.chosen)
    .sort((a, b) => (a.totalCost ?? 0) - (b.totalCost ?? 0))[0];

  return (
    <div>
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
        Where to enter the chain
      </h2>

      <p className="mb-3 text-sm leading-relaxed text-ink-dim">
        {chosen === undefined ? (
          <>Buying the finished book outright beats every merge route here.</>
        ) : (
          <>
            Cheapest is to buy <span className="num text-ink">{chosen.unitsRequired}</span>×{" "}
            <span className="text-ink">{displayTag(chosen.tag)}</span> for{" "}
            <span className="num text-ink">{formatCoins(chosen.totalCost ?? 0)}</span> and merge
            up.
            {runnerUp !== undefined && (
              <>
                {" "}
                The next best entry costs{" "}
                <span className="num">{formatCoins(runnerUp.totalCost ?? 0)}</span> — a
                difference of{" "}
                <span className="num">
                  {formatCoins((runnerUp.totalCost ?? 0) - (chosen.totalCost ?? 0))}
                </span>
                .
              </>
            )}
            {plan.directPrice !== null && (
              <>
                {" "}
                Buying the finished book instead costs{" "}
                <span className="num">{formatCoins(plan.directPrice)}</span>, so merging{" "}
                {plan.beatsDirect ? "wins" : "does not win"}.
              </>
            )}
          </>
        )}
      </p>

      <table className="w-full border-collapse text-sm">
        <thead className="border-b border-rule-strong text-xs text-ink-faint">
          <tr>
            <th scope="col" className="px-2 py-1 text-left font-medium">
              Entry rung
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Price each
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Books needed
            </th>
            <th scope="col" className="px-2 py-1 text-right font-medium">
              Total cost
            </th>
          </tr>
        </thead>
        <tbody>
          {ladder.map((rung) => (
            <tr
              key={rung.tag}
              className={`border-b border-rule last:border-b-0 ${
                rung.chosen ? "bg-raised text-ink" : "text-ink-dim"
              }`}
            >
              <td className="px-2 py-1 text-left">
                {displayTag(rung.tag)}
                {rung.chosen && (
                  <span className="ml-2 text-[10px] tracking-wide text-profit uppercase">
                    chosen
                  </span>
                )}
                {rung.gatedAbove === true && (
                  <span
                    className="ml-2 text-[10px] tracking-wide text-outage uppercase"
                    // ADR-025: an implied merge ratio past 3 means the merge does not
                    // exist, so this rung's cost is not actually reachable.
                    title="The market prices this rung as un-mergeable — the next level up is obtained elsewhere in the game, not from an anvil."
                  >
                    gated
                  </span>
                )}
              </td>
              <td className="num px-2 py-1 text-right">
                {/* Unpriced is not free. A thin intermediate rung that has not traded has
                    no price, and rendering 0 would make it look like the best entry. */}
                {rung.price === null ? (
                  <span className="text-ink-faint" title="No recent price for this rung">
                    unpriced
                  </span>
                ) : (
                  formatCoins(rung.price)
                )}
              </td>
              <td className="num px-2 py-1 text-right">{rung.unitsRequired}</td>
              <td className={`num px-2 py-1 text-right ${rung.chosen ? "text-profit" : ""}`}>
                {rung.totalCost === null ? "—" : formatCoins(rung.totalCost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-xs leading-relaxed text-ink-faint">
        Each level up consumes two books of the level below, so the count doubles at every rung.
        Every merge in this chain is unverified — whether each rung genuinely combines is a fact
        about the game that name matching cannot confirm.
      </p>
    </div>
  );
}
