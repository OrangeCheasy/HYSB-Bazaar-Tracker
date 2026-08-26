import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCoins } from "../format.js";
import type { PriceChartProps, Tone } from "./types.js";

/**
 * THE ONLY FILE IN THIS PROJECT THAT IMPORTS A CHARTING LIBRARY.
 *
 * Everything above it speaks the vocabulary in `./types.ts` — series, levels, spans, tones
 * — so swapping Recharts for uPlot when a 2,000-point hourly series starts to feel sluggish
 * touches this file and nothing else (ROADMAP Phase 5). Isolating the library is the point;
 * picking the perfect one up front is not.
 *
 * It is also loaded lazily (see `./lazy.ts`): Recharts is roughly the size of the entire
 * rest of the bundle, and the two table views — including the landing route, which is what
 * a Lighthouse run measures — have no business downloading it.
 */

/** Tones map to the theme's semantic tokens, resolved at render so a future light theme
 *  needs no change here. */
const TONE_VAR: Readonly<Record<Tone, string>> = {
  ask: "var(--color-loss)",
  bid: "var(--color-profit)",
  buy: "var(--color-profit)",
  sell: "var(--color-loss)",
  neutral: "var(--color-ink-faint)",
};

interface Row {
  ts: number;
  [key: string]: number;
}

/**
 * Recharts wants one row per x with a key per series. Our series are separate arrays that
 * may not share timestamps — a thin book simply has no row for some hours — so they are
 * merged on ts rather than assumed aligned. A missing value stays absent, which draws a
 * gap; filling it would invent a price.
 */
function mergeSeries(props: PriceChartProps): Row[] {
  const byTs = new Map<number, Row>();
  for (const series of props.series) {
    for (const point of series.points) {
      let row = byTs.get(point.ts);
      if (row === undefined) {
        row = { ts: point.ts };
        byTs.set(point.ts, row);
      }
      row[series.key] = point.value;
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function PriceChart(props: PriceChartProps): React.JSX.Element {
  const { series, levels = [], spans = [], timeZone, height = 260, ariaLabel } = props;
  const rows = mergeSeries(props);

  const timeFormat = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
  const axisFormat = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone,
  });

  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* Right margin leaves room for the level labels to sit OUTSIDE the plot area. Inside
            it they were drawn over the series — the "sell band" label landed on the ask line
            and became unreadable, which defeats labelling it at all. */}
        <LineChart data={rows} margin={{ top: 8, right: 64, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-rule)" strokeDasharray="2 4" vertical={false} />

          {/* Shaded first so lines and levels draw over them. */}
          {spans.map((span) => (
            <ReferenceArea
              key={span.key}
              x1={span.fromTs}
              x2={span.toTs}
              fill={TONE_VAR[span.tone]}
              fillOpacity={0.08}
              stroke="none"
            />
          ))}

          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            scale="time"
            tickFormatter={(ts: number) => axisFormat.format(new Date(ts * 1000))}
            stroke="var(--color-ink-faint)"
            tick={{ fontSize: 11 }}
            minTickGap={40}
          />
          <YAxis
            stroke="var(--color-ink-faint)"
            tick={{ fontSize: 11 }}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={(value: number) => formatCoins(value)}
          />

          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-rule-strong)",
              borderRadius: 2,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--color-ink-dim)" }}
            // Recharts types these as possibly-undefined and it means it: a tooltip can
            // fire on a row where a series has no point. Narrowing here rather than
            // asserting keeps the gap rendering honest instead of printing "NaN".
            labelFormatter={(ts: unknown) =>
              typeof ts === "number" ? timeFormat.format(new Date(ts * 1000)) : ""
            }
            formatter={(value: unknown, key: unknown) => [
              typeof value === "number" ? formatCoins(value) : "—",
              series.find((s) => s.key === key)?.label ?? String(key ?? ""),
            ]}
          />

          {/* The band levels. A horizontal line through the series is what makes "how often
              did price touch this" answerable by looking rather than by reading a number. */}
          {levels.map((level) => (
            <ReferenceLine
              key={level.key}
              y={level.value}
              stroke={TONE_VAR[level.tone]}
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{
                value: level.label,
                position: "right",
                fill: TONE_VAR[level.tone],
                fontSize: 11,
              }}
            />
          ))}

          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={TONE_VAR[s.tone]}
              strokeWidth={1.5}
              strokeDasharray={s.style === "dashed" ? "4 3" : undefined}
              dot={false}
              // A gap is a gap. Connecting across it draws a price that was never quoted.
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
