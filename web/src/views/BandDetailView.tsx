import { Link, useParams } from "react-router";
import type { BandHitRate } from "@core/index.js";
import { fetchBand, fetchItemHistory } from "../api/endpoints.js";
import { useApi } from "../api/useApi.js";
import { PriceChart } from "../charts/lazy.js";
import type { Level, Series } from "../charts/types.js";
import { formatAge, formatCoins, formatPercentPoints } from "../format.js";
import { queryString, toBandQuery } from "../settings/toQuery.js";
import { useSettings } from "../settings/store.js";
import { displayTag } from "../tagName.js";
import { Flags } from "../ui/Flags.js";
import { LoadError, TableSkeleton } from "../ui/TableStates.js";
import { useNow } from "../useNow.js";

/**
 * One tag's band, with the chart that makes the hit-rate checkable.
 *
 * The table asserts "price touched this band 35% of hours". This page draws the band as a
 * line through the actual series so a reader can see it — which is the difference between
 * being told a number and being shown the evidence for it. ROADMAP Phase 5 asks for
 * exactly that: "answered visually rather than asserted".
 */

/** The most weeks the 30-day retention cap can contain (ADR-021). */
const FULL_HISTORY_WEEKS = 4;

function HitRate({
  hits,
  side,
  band,
}: {
  readonly hits: BandHitRate;
  readonly side: "buy" | "sell";
  readonly band: number;
}): React.JSX.Element {
  const pct = Math.round(hits.rate * 100);
  return (
    <div className="border border-rule bg-surface px-3 py-2">
      <h2 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
        {side === "buy" ? "Buy order at" : "Sell offer at"}
      </h2>
      <p className="num mt-1 text-lg text-ink">{formatCoins(band)}</p>
      {/* The hit-rate is never further from the band than this. A p10 buy order sits
          unfilled ~90% of the time by construction, so the band alone is not a trade. */}
      <p className="num mt-1 text-sm text-ink-dim">
        {pct}% of hours touched it
        <span className="ml-1 text-ink-faint">
          ({hits.hoursTouched} of {hits.hoursTotal})
        </span>
      </p>
    </div>
  );
}

export function BandDetailView(): React.JSX.Element {
  const { tag = "" } = useParams();
  const settings = useSettings();
  const now = useNow();

  const bandPath = `/api/bands/${encodeURIComponent(tag)}${queryString(toBandQuery(settings))}`;
  const band = useApi(bandPath, (signal) => fetchBand(tag, settings, signal));

  // The chart covers the same trailing window the band was computed over, so a line drawn
  // across it is a claim about the data on screen and not about some other period.
  const range = settings.windowDays <= 1 ? "1d" : settings.windowDays <= 7 ? "7d" : "30d";
  const historyPath = `/api/item/${encodeURIComponent(tag)}/history?range=${range}`;
  const history = useApi(historyPath, (signal) => fetchItemHistory(tag, range, signal));

  const series: Series[] = [];
  if (history.data !== undefined) {
    series.push(
      {
        key: "bid",
        label: "Bid (your buy order competes here)",
        tone: "bid",
        points: history.data.map((p) => ({ ts: p.ts, value: p.bidAvg })),
      },
      {
        key: "ask",
        label: "Ask (your sell offer competes here)",
        tone: "ask",
        points: history.data.map((p) => ({ ts: p.ts, value: p.askAvg })),
      },
    );
  }

  const levels: Level[] =
    band.data === undefined
      ? []
      : [
          { key: "buy", value: band.data.buyBand, label: "buy band", tone: "buy" },
          { key: "sell", value: band.data.sellBand, label: "sell band", tone: "sell" },
        ];

  const staleFor =
    band.meta !== undefined ? Math.max(0, now - band.meta.generatedAt) : undefined;

  return (
    <section className="max-w-5xl">
      <header className="mb-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-base font-semibold tracking-tight text-ink">{displayTag(tag)}</h1>
          <span className="num text-xs text-ink-faint">{tag}</span>
          {band.data !== undefined && <Flags flags={band.data.flags} />}
          <Link to="/" className="ml-auto text-xs text-accent hover:underline">
            back to all bands
          </Link>
        </div>
        {staleFor !== undefined && (
          <p className="mt-1 text-xs text-ink-faint">
            computed <span className="num">{formatAge(staleFor)}</span> ago
          </p>
        )}
      </header>

      {band.error !== undefined && (
        <LoadError error={band.error} stale={band.data !== undefined} />
      )}

      {band.data === undefined && band.loading && <TableSkeleton rows={4} />}

      {band.data !== undefined && (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <HitRate hits={band.data.buyHits} side="buy" band={band.data.buyBand} />
            <HitRate hits={band.data.sellHits} side="sell" band={band.data.sellBand} />
            <div className="border border-rule bg-surface px-3 py-2">
              <h2 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                Spread
              </h2>
              <p className="num mt-1 text-lg text-ink">
                {formatPercentPoints(band.data.spreadPct)}
              </p>
              {/* The spread is this view's margin figure, so its fill-feasibility companion
                  stays beside it: the profit is conditional on BOTH orders filling. */}
              <p className="num mt-1 text-sm text-ink-dim">
                both filled in {band.data.bothHitWeeks} of {band.data.weekCount}{" "}
                {band.data.weekCount === 1 ? "week" : "weeks"}
              </p>
            </div>
          </div>

          {/* Stated plainly, in a sentence, rather than as a badge. A "2 of 2 weeks" that
              looks perfect is resting on two weeks, and a reader deciding with real coins
              should be told the size of the sample in words. */}
          <p className="mt-2 border-l-2 border-rule-strong pl-3 text-xs leading-relaxed text-ink-dim">
            This band is computed from{" "}
            <span className="num">{band.data.buyHits.hoursTotal}</span> hourly rows spanning{" "}
            <span className="num">{band.data.weekCount}</span>{" "}
            {band.data.weekCount === 1 ? "week" : "weeks"}.
            {band.data.weekCount < FULL_HISTORY_WEEKS && (
              <>
                {" "}
                That is fewer than the four weeks the 30-day retention window can hold, so any
                claim about how often this band has held rests on{" "}
                <span className="num">{band.data.weekCount}</span>{" "}
                {band.data.weekCount === 1 ? "observation" : "observations"}, not a track
                record.
              </>
            )}
          </p>

          <div className="mt-4">
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
              Price against both bands
            </h2>
            {history.error !== undefined && (
              <LoadError error={history.error} stale={history.data !== undefined} />
            )}
            {history.data === undefined && history.loading ? (
              <TableSkeleton rows={3} />
            ) : (
              <PriceChart
                series={series}
                levels={levels}
                timeZone={settings.timeZone}
                height={300}
                ariaLabel={`Bid and ask for ${displayTag(tag)} over the trailing ${band.data.weekCount === 1 ? "week" : `${band.data.weekCount} weeks`}, with the buy band at ${formatCoins(band.data.buyBand)} and the sell band at ${formatCoins(band.data.sellBand)} drawn as horizontal lines`}
              />
            )}
            <p className="mt-2 text-xs text-ink-faint">
              The dashed lines are the two bands. Every time the green series dips to the lower
              line, a buy order resting there would have filled; every time the red series
              reaches the upper line, a sell offer would have. That is what the percentages
              above are counting.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
