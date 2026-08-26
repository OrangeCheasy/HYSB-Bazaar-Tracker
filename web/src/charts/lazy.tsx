import { Suspense, lazy } from "react";
import type { HourChartProps, PriceChartProps } from "./types.js";

/**
 * The code-splitting boundary for the charting library.
 *
 * Recharts is roughly the size of the entire rest of this bundle. Two of six routes use it,
 * and neither is the landing route — which is the one a Lighthouse run measures against the
 * >90 target in ROADMAP Phase 5. So the tables never download it, and a detail page pays
 * for it on navigation.
 *
 * Both charts come from the same chunk on purpose: they are always on the same page as each
 * other or not needed at all, so splitting them separately would mean two round trips for
 * one screen.
 */

const PriceChartImpl = lazy(async () => ({
  default: (await import("./PriceChart.js")).PriceChart,
}));

const HourChartImpl = lazy(async () => ({
  default: (await import("./HourChart.js")).HourChart,
}));

/** Holds the chart's exact height while the chunk loads, so the page does not jump. */
function ChartFallback({ height }: { readonly height: number }): React.JSX.Element {
  return (
    <div
      className="flex animate-pulse items-center justify-center border border-rule bg-surface text-xs text-ink-faint"
      style={{ height }}
    >
      loading chart…
    </div>
  );
}

export function PriceChart(props: PriceChartProps): React.JSX.Element {
  return (
    <Suspense fallback={<ChartFallback height={props.height ?? 260} />}>
      <PriceChartImpl {...props} />
    </Suspense>
  );
}

export function HourChart(props: HourChartProps): React.JSX.Element {
  return (
    <Suspense fallback={<ChartFallback height={props.height ?? 180} />}>
      <HourChartImpl {...props} />
    </Suspense>
  );
}
