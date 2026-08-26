/**
 * The chart vocabulary this app speaks.
 *
 * Deliberately free of anything Recharts: no `dataKey`, no `ReferenceLine`, no
 * `ResponsiveContainer`. `PriceChart.tsx` is the only file in the project that imports the
 * library, so swapping to uPlot when a 2,000-point hourly series starts to feel sluggish is
 * a one-file change (ROADMAP Phase 5). If a type in here starts to look like a Recharts
 * prop, the abstraction has leaked.
 *
 * Everything is in UTC epoch seconds, per CLAUDE.md §5 — formatting into the viewer's zone
 * happens inside the chart, from the `timeZone` prop.
 */

export interface Point {
  /** UTC epoch seconds. */
  readonly ts: number;
  readonly value: number;
}

/** Semantic tones, not colours. The chart maps them to the theme's tokens. */
export type Tone = "ask" | "bid" | "buy" | "sell" | "neutral";

export interface Series {
  readonly key: string;
  readonly label: string;
  readonly points: readonly Point[];
  readonly tone: Tone;
  readonly style?: "solid" | "dashed";
}

/**
 * A horizontal line at a fixed price — the band levels.
 *
 * This is what turns "price touched this band 35% of hours" from an assertion into
 * something a reader can check by looking, which is the entire point of the band detail
 * chart.
 */
export interface Level {
  readonly key: string;
  readonly value: number;
  readonly label: string;
  readonly tone: Tone;
}

/**
 * A shaded time range — the buy and sell windows.
 *
 * These are hours of the DAY, not one absolute range, so a week-long chart carries one
 * span per day. The caller expands them (see `dailySpans`), because the chart should not
 * have to know what a sleep window is.
 */
export interface Span {
  readonly key: string;
  readonly fromTs: number;
  readonly toTs: number;
  readonly tone: Tone;
  readonly label?: string;
}

export interface PriceChartProps {
  readonly series: readonly Series[];
  readonly levels?: readonly Level[];
  readonly spans?: readonly Span[];
  /** IANA zone for axis and tooltip formatting. */
  readonly timeZone: string;
  readonly height?: number;
  /** Accessible description of what the chart shows. */
  readonly ariaLabel: string;
}

/** One bar per hour of the day, 0-23. */
export interface HourBar {
  readonly hour: number;
  readonly value: number;
  /** Zero means the hour has no data — the chart must not draw it as a price of zero. */
  readonly samples: number;
}

export interface HourChartProps {
  readonly bars: readonly HourBar[];
  /** The 24-hour mean, drawn as the line the bars are relative to. */
  readonly baseline?: number;
  /** Hours to shade — the sleep window, or the chosen sell window. */
  readonly highlightHours?: readonly number[];
  readonly highlightTone?: Tone;
  readonly label: string;
  readonly height?: number;
  readonly ariaLabel: string;
}
