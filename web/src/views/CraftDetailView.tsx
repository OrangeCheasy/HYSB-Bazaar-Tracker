import { Link, useParams } from "react-router";
import type { CraftRow, ScenarioKind, ScenarioResult } from "@core/index.js";
import { fetchCraft, fetchItemHistory, fetchItemHours } from "../api/endpoints.js";
import { useApi } from "../api/useApi.js";
import { HourChart, PriceChart } from "../charts/lazy.js";
import { dailySpans, windowHours } from "../charts/spans.js";
import type { Series, Span } from "../charts/types.js";
import { formatAge, formatCoins, formatHour, formatHours, formatPercent } from "../format.js";
import { EntryLadder } from "../scan/EntryLadder.js";
import { FlagExplanations } from "../scan/CraftFlags.js";
import { utcOffsetHours } from "../settings/schema.js";
import { queryString, toScanQuery } from "../settings/toQuery.js";
import { useSettings } from "../settings/store.js";
import { displayTag } from "../tagName.js";
import { LoadError, TableSkeleton } from "../ui/TableStates.js";
import { useNow } from "../useNow.js";

/**
 * One craft, explained.
 *
 * The scan table exists to be scanned; this page exists to be read. So it spends the space
 * the table could not: three scenarios side by side, the windows drawn rather than
 * described, and every warning flag written out as what to actually do about it.
 */

const SCENARIO_COPY: Readonly<
  Record<ScenarioKind, { readonly title: string; readonly blurb: string }>
> = {
  floor: {
    title: "Instant both ways",
    blurb:
      "You instant-buy the materials and instant-sell the product. Nothing rests, nothing can fail to fill, and this is the worst price you will get. Treat it as the floor: if this is positive, the craft works even when you are impatient.",
  },
  orders: {
    title: "Both orders fill",
    blurb:
      "You place a buy order and a sell offer, both at the current top of book, and both fill. This is the number most tools quote. It is real, but only conditional on two orders filling — which is what the fill figure beside it is measuring.",
  },
  timed: {
    title: "Timed windows",
    blurb:
      "Your buy order rests overnight while you sleep, and your sell offer sits in the dearest window of the day. This is the scenario the ranking uses, because it is what someone setting up orders for the evening is actually doing.",
  },
};

function ScenarioCard({
  kind,
  scenario,
  highlight,
}: {
  readonly kind: ScenarioKind;
  readonly scenario: ScenarioResult;
  readonly highlight: boolean;
}): React.JSX.Element {
  const copy = SCENARIO_COPY[kind];
  const profitable = scenario.profitPerCraft >= 0;
  return (
    <div
      className={`border px-3 py-2 ${
        highlight ? "border-rule-strong bg-raised" : "border-rule bg-surface"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-ink uppercase">{copy.title}</h3>
        {highlight && <span className="text-[10px] text-ink-faint">ranked on this</span>}
      </div>

      <p className={`num mt-2 text-lg ${profitable ? "text-profit" : "text-loss"}`}>
        {formatPercent(scenario.marginPct)}
      </p>
      {/* Adjacent, always. CLAUDE.md §7.6 — a margin without its fill feasibility is a
          number nobody can act on, and this applies per scenario, not once per page. */}
      <p className="num text-sm text-ink-dim">
        {formatPercent(scenario.fillFeasibility, 0)} fill feasibility
      </p>

      <dl className="mt-3 space-y-1 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-ink-faint">Cost per craft</dt>
          <dd className="num text-ink-dim">{formatCoins(scenario.costPerCraft)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-faint">Sells for</dt>
          <dd className="num text-ink-dim">{formatCoins(scenario.grossPerCraft)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-ink-faint">Tax</dt>
          <dd className="num text-ink-dim">−{formatCoins(scenario.taxPerCraft)}</dd>
        </div>
        <div className="flex justify-between gap-2 border-t border-rule pt-1">
          <dt className="text-ink-faint">Profit per craft</dt>
          <dd className={`num ${profitable ? "text-profit" : "text-loss"}`}>
            {formatCoins(scenario.profitPerCraft)}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-xs leading-relaxed text-ink-faint">{copy.blurb}</p>
    </div>
  );
}

function CraftBody({ row }: { readonly row: CraftRow }): React.JSX.Element {
  const settings = useSettings();
  const offset = utcOffsetHours();
  const analysis = row.analysis;

  const baseTag = row.recipe.baseTag;
  const productTag = row.recipe.enchTag;

  const baseHistory = useApi(`/api/item/${encodeURIComponent(baseTag)}/history?range=7d`, (s) =>
    fetchItemHistory(baseTag, "7d", s),
  );
  const productHistory = useApi(
    `/api/item/${encodeURIComponent(productTag)}/history?range=7d`,
    (s) => fetchItemHistory(productTag, "7d", s),
  );
  const hours = useApi(`/api/item/${encodeURIComponent(baseTag)}/hours?days=30`, (s) =>
    fetchItemHours(baseTag, 30, s),
  );

  const series: Series[] = [];
  if (baseHistory.data !== undefined) {
    series.push({
      key: "baseBid",
      label: `${displayTag(baseTag)} bid — where your buy order rests`,
      tone: "buy",
      points: baseHistory.data.map((p) => ({ ts: p.ts, value: p.bidAvg })),
    });
  }
  if (productHistory.data !== undefined) {
    series.push({
      key: "productAsk",
      label: `${displayTag(productTag)} ask — where your sell offer rests`,
      tone: "sell",
      style: "dashed",
      points: productHistory.data.map((p) => ({ ts: p.ts, value: p.askAvg })),
    });
  }

  // The windows are hours of the day, so a week-long chart shades one region per day.
  const bounds = series[0]?.points ?? [];
  const fromTs = bounds[0]?.ts ?? 0;
  const toTs = bounds[bounds.length - 1]?.ts ?? 0;
  const spans: Span[] = [
    ...dailySpans({
      fromTs,
      toTs,
      startHour: settings.sleepStartLocal,
      endHour: settings.sleepEndLocal,
      tone: "buy",
      keyPrefix: "buy",
      label: "buy window",
      utcOffsetHours: offset,
    }),
  ];

  const sleepHours = windowHours(settings.sleepStartLocal, settings.sleepEndLocal);

  return (
    <>
      {analysis !== undefined && (
        <>
          {/* An h2 before the cards, whose titles are h3. Without it the page jumps h1 to
              h3, which a screen-reader user navigating by heading reads as a missing
              section — and it needed a label anyway. */}
          <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            Three ways to price this craft
          </h2>
          <div className="grid gap-2 lg:grid-cols-3">
            {(["floor", "orders", "timed"] as const).map((kind) => (
              <ScenarioCard
                key={kind}
                kind={kind}
                scenario={analysis.scenarios[kind]}
                highlight={kind === "timed"}
              />
            ))}
          </div>
        </>
      )}

      {analysis !== undefined && (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Profit / day</p>
            <p
              className={`num mt-1 text-base ${analysis.profitPerDay >= 0 ? "text-profit" : "text-loss"}`}
            >
              {formatCoins(analysis.profitPerDay)}
            </p>
          </div>
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Crafts / day</p>
            <p className="num mt-1 text-base text-ink">
              {formatCoins(analysis.throughput.craftsPerDay)}
            </p>
            <p className="mt-1 text-ink-faint">limited by {analysis.throughput.limitedBy}</p>
          </div>
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Hours to fill one craft</p>
            <p className="num mt-1 text-base text-ink">
              {formatHours(analysis.throughput.hoursToFillOneCraft)}
            </p>
          </div>
          <div className="border border-rule bg-surface px-3 py-2">
            <p className="text-ink-faint">Capital for a day</p>
            <p className="num mt-1 text-base text-ink">
              {formatCoins(analysis.capitalRequired)}
            </p>
          </div>
        </div>
      )}

      {row.plan !== undefined && row.ladder !== undefined && row.ladder.length > 0 && (
        <div className="mt-6">
          <EntryLadder ladder={row.ladder} plan={row.plan} />
        </div>
      )}

      <div className="mt-6">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
          Both sides of the trade, with your buy window shaded
        </h2>
        {baseHistory.data === undefined && baseHistory.loading ? (
          <TableSkeleton rows={3} />
        ) : (
          <PriceChart
            series={series}
            spans={spans}
            timeZone={settings.timeZone}
            height={300}
            ariaLabel={`Bid for ${displayTag(baseTag)} and ask for ${displayTag(productTag)} over the last seven days, with the overnight buy window from ${formatHour(settings.sleepStartLocal)} to ${formatHour(settings.sleepEndLocal)} shaded on each day`}
          />
        )}
        <p className="mt-2 text-xs text-ink-faint">
          Shaded regions are the hours your buy order sits unattended —{" "}
          {formatHour(settings.sleepStartLocal)} to {formatHour(settings.sleepEndLocal)} in{" "}
          <span className="num">{settings.timeZone}</span>, adjustable in settings. The timed
          scenario prices the base at what the book does during those hours, not at what it
          costs right now.
        </p>
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-xs font-semibold tracking-wide text-ink-faint uppercase">
          {displayTag(baseTag)} by hour of day
        </h2>
        {hours.data === undefined && hours.loading ? (
          <TableSkeleton rows={2} />
        ) : hours.data === undefined ? (
          <p className="text-sm text-ink-faint">
            No hour-of-day profile yet for this material.
          </p>
        ) : (
          <HourChart
            bars={hours.data.buckets.map((b) => ({
              hour: b.hour,
              value: b.bidMean,
              samples: b.samples,
            }))}
            baseline={hours.data.bidBaseline}
            highlightHours={sleepHours}
            highlightTone="buy"
            label="mean bid"
            ariaLabel={`Mean bid for ${displayTag(baseTag)} by hour of day over ${hours.data.days} days, with the buy window highlighted`}
          />
        )}
        <p className="mt-2 text-xs text-ink-faint">
          Highlighted bars are your buy window. A material that is reliably cheapest inside it
          is one your overnight order gets a good price on; one that is dearest inside it is a
          reason to move the window.
        </p>
      </div>

      {analysis !== undefined && analysis.flags.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-3 text-xs font-semibold tracking-wide text-ink-faint uppercase">
            What to watch out for
          </h2>
          <FlagExplanations flags={analysis.flags} />
        </div>
      )}
    </>
  );
}

export function CraftDetailView(): React.JSX.Element {
  const { baseTag = "" } = useParams();
  const settings = useSettings();
  const now = useNow();

  const path = `/api/craft/${encodeURIComponent(baseTag)}${queryString(toScanQuery(settings))}`;
  const { data, meta, error, loading } = useApi(path, (signal) =>
    fetchCraft(baseTag, settings, signal),
  );

  const row = data?.[0];
  const staleFor = meta !== undefined ? Math.max(0, now - meta.generatedAt) : undefined;

  return (
    <section className="max-w-5xl">
      <header className="mb-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-base font-semibold tracking-tight text-ink">
            {row === undefined ? displayTag(baseTag) : displayTag(row.recipe.enchTag)}
          </h1>
          {row !== undefined && (
            <span className="text-xs text-ink-dim">
              {row.recipe.ratio}× {displayTag(row.recipe.baseTag)}
              {row.kind === "anvil" && <span className="ml-2 text-ink-faint">anvil merge</span>}
            </span>
          )}
          <Link to="/scan" className="ml-auto text-xs text-accent hover:underline">
            back to all crafts
          </Link>
        </div>
        {staleFor !== undefined && (
          <p className="mt-1 text-xs text-ink-faint">
            computed <span className="num">{formatAge(staleFor)}</span> ago
          </p>
        )}
        {row !== undefined && !row.recipe.verified && (
          <p className="mt-2 border-l-2 border-late pl-3 text-xs leading-relaxed text-ink-dim">
            This recipe&rsquo;s ratio is <span className="text-late">unverified</span> — nobody
            has confirmed it against a crafting grid. If it is wrong, every coin figure below is
            wrong in proportion.
          </p>
        )}
      </header>

      {error !== undefined && <LoadError error={error} stale={data !== undefined} />}
      {data === undefined && loading && <TableSkeleton rows={5} />}

      {row !== undefined && row.analysis === undefined && (
        <div className="mb-4 border border-rule bg-surface px-4 py-3 text-sm">
          <h2 className="font-semibold text-ink">
            {row.error === "buying-beats-merging"
              ? "Buying beats merging here"
              : "No economics for this craft yet"}
          </h2>
          <p className="mt-2 text-ink-dim">
            {row.error === "buying-beats-merging"
              ? "Every merge route into this book costs more than simply buying the finished book. That is a real answer rather than a failure — there is just no craft to price, so the ladder below is the comparison itself."
              : `The analysis could not be computed: ${row.error ?? "unknown reason"}. Most often this means one of the two tags has no price history yet.`}
          </p>
        </div>
      )}

      {row !== undefined && <CraftBody row={row} />}
    </section>
  );
}
