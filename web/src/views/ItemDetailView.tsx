import { useState } from "react";
import { Link, useParams } from "react-router";
import type { Stats, StatsWindow } from "@core/index.js";
import { fetchItem, fetchItemHistory, type ItemHistoryRange } from "../api/endpoints.js";
import { useApi } from "../api/useApi.js";
import { PriceChart } from "../charts/lazy.js";
import type { Series } from "../charts/types.js";
import { formatAge, formatCoins, formatHours, formatPercent } from "../format.js";
import { useSettings } from "../settings/store.js";
import { displayTag } from "../tagName.js";
import { LoadError, TableSkeleton } from "../ui/TableStates.js";
import { useNow } from "../useNow.js";

/**
 * One item's market, with no opinion about it.
 *
 * This page carries no trade recommendation, which is why it has no headline number and no
 * margin anywhere on it. The adjacency rules in CLAUDE.md §7.6 attach to a figure someone
 * might act on; inventing one here purely to have something large at the top would be
 * manufacturing exactly the kind of number those rules exist to constrain.
 *
 * What it does instead is qualify every figure it shows, because most of them are quietly
 * conditional: a volatility computed over four days, a depth reading from one snapshot, a
 * window assembled from a fraction of its hours.
 */

const RANGES: readonly { readonly key: ItemHistoryRange; readonly label: string }[] = [
  { key: "1d", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

const WINDOWS: readonly StatsWindow[] = ["1d", "7d", "30d"];

/** A stat and the caveat it needs, if it needs one. */
function Figure({
  label,
  value,
  caveat,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly caveat?: string;
  readonly tone?: "warn";
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className={`num text-sm ${tone === "warn" ? "text-late" : "text-ink-dim"}`}>
        {value}
        {caveat !== undefined && (
          // Beside the number, not in a footnote. A volatility from four days and one from
          // thirty look identical until something says otherwise.
          <span className="ml-1 text-[10px] text-ink-faint">{caveat}</span>
        )}
      </dd>
    </div>
  );
}

/** Hours expected in a window, for turning `coverage` into a sentence. */
const WINDOW_HOURS: Readonly<Record<StatsWindow, number>> = { "1d": 24, "7d": 168, "30d": 720 };

function StatsColumn({
  window,
  stats,
}: {
  readonly window: StatsWindow;
  readonly stats: Stats | null;
}): React.JSX.Element {
  if (stats === null) {
    return (
      <div className="border border-rule bg-surface px-3 py-2">
        <h3 className="text-xs font-semibold tracking-wide text-ink uppercase">{window}</h3>
        <p className="mt-2 text-xs text-ink-faint">
          Not enough history yet for this window. Nothing is wrong with the item — it simply has
          not been collected for{" "}
          {window === "1d" ? "a day" : window === "7d" ? "a week" : "a month"} yet.
        </p>
      </div>
    );
  }

  // Coverage below 1 means hours are missing from the window. That is the difference
  // between a 30-day average and an average of whichever 30 days happened to record, and
  // CLAUDE.md §3b is explicit that it must be surfaced rather than averaged away.
  const gappy = stats.coverage < 0.9;
  const thin = stats.n < WINDOW_HOURS[window] * 0.5;

  return (
    <div className="border border-rule bg-surface px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-ink uppercase">{window}</h3>
        <span className={`num text-[10px] ${gappy ? "text-late" : "text-ink-faint"}`}>
          {stats.n} hrs · {formatPercent(stats.coverage, 0)} covered
        </span>
      </div>

      <dl className="mt-2 divide-y divide-rule">
        <Figure label="Ask (you pay)" value={formatCoins(stats.askMean)} />
        <Figure label="Bid (you receive)" value={formatCoins(stats.bidMean)} />
        <Figure label="Spread" value={formatPercent(stats.spreadPct)} />
        <Figure
          label="Volatility"
          value={formatPercent(stats.volatility)}
          caveat={thin ? `on ${stats.n}h` : undefined}
          tone={thin ? "warn" : undefined}
        />
        <Figure label="Instant-bought / day" value={formatCoins(stats.ibPerDay)} />
        <Figure label="Instant-sold / day" value={formatCoins(stats.isPerDay)} />
      </dl>
    </div>
  );
}

export function ItemDetailView(): React.JSX.Element {
  const { tag = "" } = useParams();
  const settings = useSettings();
  const now = useNow();
  const [range, setRange] = useState<ItemHistoryRange>("7d");

  const item = useApi(`/api/item/${encodeURIComponent(tag)}`, (s) => fetchItem(tag, s));
  const history = useApi(`/api/item/${encodeURIComponent(tag)}/history?range=${range}`, (s) =>
    fetchItemHistory(tag, range, s),
  );

  const series: Series[] = [];
  if (history.data !== undefined) {
    series.push(
      {
        key: "bid",
        label: "Bid — what you receive on an instant-sell",
        tone: "bid",
        points: history.data.map((p) => ({ ts: p.ts, value: p.bidAvg })),
      },
      {
        key: "ask",
        label: "Ask — what you pay on an instant-buy",
        tone: "ask",
        points: history.data.map((p) => ({ ts: p.ts, value: p.askAvg })),
      },
    );
  }

  const windows = item.data?.windows;

  // Depth is the current book, taken from the newest bar rather than averaged — a queue
  // that exists right now, not one that existed on average. Its age is therefore the age of
  // that bar, and worth stating.
  //
  // The narrowest window that computed. Each is `Stats | null`, and all three can be null
  // on a tag with almost no history — `??` alone would leave a null in `latest`.
  const latest =
    [windows?.["1d"], windows?.["7d"], windows?.["30d"]].find(
      (stats): stats is Stats => stats != null,
    ) ?? undefined;
  const depthAge = latest === undefined ? undefined : Math.max(0, now - latest.to);

  return (
    <section className="max-w-5xl">
      <header className="mb-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-base font-semibold tracking-tight text-ink">{displayTag(tag)}</h1>
          <span className="num text-xs text-ink-faint">{tag}</span>
          <Link to="/items" className="ml-auto text-xs text-accent hover:underline">
            back to all items
          </Link>
        </div>
      </header>

      {item.error !== undefined && (
        <LoadError error={item.error} stale={item.data !== undefined} />
      )}
      {item.data === undefined && item.loading && <TableSkeleton rows={4} />}

      {latest !== undefined && (
        <div className="mb-4 grid gap-2 text-xs sm:grid-cols-4">
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Sell offers resting</p>
            <p className="num mt-1 text-base text-ink">{formatCoins(latest.lastAskDepth)}</p>
            <p className="mt-1 text-ink-faint">
              units ahead of yours if you offer at {formatCoins(latest.lastAsk)}
            </p>
          </div>
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Buy orders resting</p>
            <p className="num mt-1 text-base text-ink">{formatCoins(latest.lastBidDepth)}</p>
            <p className="mt-1 text-ink-faint">
              units ahead of yours if you order at {formatCoins(latest.lastBid)}
            </p>
          </div>
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Hours to clear the buy queue</p>
            <p className="num mt-1 text-base text-ink">
              {formatHours(
                latest.isPerHour > 0
                  ? latest.lastBidDepth / latest.isPerHour
                  : Number.POSITIVE_INFINITY,
              )}
            </p>
            <p className="mt-1 text-ink-faint">at the current instant-sell rate</p>
          </div>
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Book read</p>
            <p className="num mt-1 text-base text-ink">
              {depthAge === undefined ? "—" : `${formatAge(depthAge)} ago`}
            </p>
            {/* Depth is one snapshot, not an average. Presenting it beside 30-day means
                without saying so invites reading it as equally settled. */}
            <p className="mt-1 text-ink-faint">a single snapshot, not an average</p>
          </div>
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-2 border-y border-rule py-2">
        <span className="text-xs text-ink-faint">Range</span>
        {RANGES.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setRange(option.key)}
            className={`rounded-sm border px-2 py-0.5 text-xs ${
              range === option.key
                ? "border-rule-strong text-ink"
                : "border-rule text-ink-dim hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-ink-faint">
          nothing older than 30 days exists — the whole dataset is a rolling month
        </span>
      </div>

      {history.error !== undefined && (
        <LoadError error={history.error} stale={history.data !== undefined} />
      )}
      {history.data === undefined && history.loading ? (
        <TableSkeleton rows={3} />
      ) : (
        <PriceChart
          series={series}
          timeZone={settings.timeZone}
          height={300}
          ariaLabel={`Ask and bid price for ${displayTag(tag)} over the last ${range}`}
        />
      )}

      {windows !== undefined && (
        <div className="mt-6">
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Across three windows
          </h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {WINDOWS.map((window) => (
              <StatsColumn key={window} window={window} stats={windows[window]} />
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Volatility is the spread of the ask around its own mean — the ask, because that is
            what you pay to buy and what your own sell offer competes against. Coverage is how
            much of each window actually recorded; below 100% the averages describe the hours
            that were collected, not the whole period.
          </p>
        </div>
      )}
    </section>
  );
}
