import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCoins, formatHour } from "../format.js";
import type { HourChartProps, Tone } from "./types.js";

/**
 * Hour-of-day profile. Lives beside PriceChart because it shares the library import and
 * the same lazy boundary — a second file importing Recharts would double the thing the
 * boundary exists to keep out of the main bundle.
 *
 * Hours are UTC on the wire and rendered in the viewer's zone, so the bar labelled 23:00 is
 * 23:00 where the reader is — which is the only version of "the hours my orders sit
 * unattended" that means anything.
 */

const TONE_VAR: Readonly<Record<Tone, string>> = {
  ask: "var(--color-loss)",
  bid: "var(--color-profit)",
  buy: "var(--color-profit)",
  sell: "var(--color-loss)",
  neutral: "var(--color-accent)",
};

export function HourChart({
  bars,
  baseline,
  highlightHours = [],
  highlightTone = "neutral",
  label,
  height = 180,
  ariaLabel,
}: HourChartProps): React.JSX.Element {
  const highlighted = new Set(highlightHours);
  // An hour with no samples is not a price of zero — it is an absence, and drawing it as a
  // zero-height bar next to real ones reads as "this hour was free".
  const rows = bars.map((bar) => ({
    hour: bar.hour,
    value: bar.samples > 0 ? bar.value : null,
    samples: bar.samples,
  }));

  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-rule)" strokeDasharray="2 4" vertical={false} />
          <XAxis
            dataKey="hour"
            stroke="var(--color-ink-faint)"
            tick={{ fontSize: 10 }}
            tickFormatter={(hour: number) => formatHour(hour)}
            interval={2}
          />
          <YAxis
            stroke="var(--color-ink-faint)"
            tick={{ fontSize: 11 }}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={(value: number) => formatCoins(value)}
          />
          <Tooltip
            cursor={{ fill: "var(--color-raised)" }}
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-rule-strong)",
              borderRadius: 2,
              fontSize: 12,
            }}
            // An hour with no samples renders as null, so the tooltip genuinely can be
            // handed nothing. Say so rather than formatting undefined into "NaN".
            labelFormatter={(hour: unknown) =>
              typeof hour === "number" ? formatHour(hour) : ""
            }
            formatter={(value: unknown) => [
              typeof value === "number" ? formatCoins(value) : "no data",
              label,
            ]}
          />
          {baseline !== undefined && (
            <ReferenceLine
              y={baseline}
              stroke="var(--color-ink-faint)"
              strokeDasharray="4 3"
              label={{
                value: "24h mean",
                position: "insideTopRight",
                fill: "var(--color-ink-faint)",
                fontSize: 10,
              }}
            />
          )}
          <Bar dataKey="value" isAnimationActive={false}>
            {rows.map((row) => (
              <Cell
                key={row.hour}
                fill={
                  highlighted.has(row.hour)
                    ? TONE_VAR[highlightTone]
                    : "var(--color-rule-strong)"
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
