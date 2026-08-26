/**
 * Display formatting. Every timestamp in this project is stored as UTC epoch seconds and
 * converted here, in the browser, using the user's own zone (CLAUDE.md §5).
 */

/** "4m", "2h 10m", "3d" — compact enough to sit in a header chip without truncating. */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds)) return "unknown";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

/** Absolute time in the user's zone, for the title attribute behind a relative age. */
export function formatInstant(epochSeconds: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(epochSeconds * 1000));
  } catch {
    // An invalid stored zone must not blank the header.
    return new Date(epochSeconds * 1000).toISOString();
  }
}

/** An hour-of-day label, e.g. 23 → "23:00". */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Coins. Bazaar prices are genuinely fractional, so rounding happens HERE and only here
 *  — never in the stored value or the model (CLAUDE.md §5). */
export function formatCoins(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (abs >= 100) return value.toFixed(0);
  return value.toFixed(2);
}

export function formatPercent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/**
 * For values that are ALREADY percentage points rather than fractions.
 *
 * Core is not consistent about this and the two live one file apart: `Stats.spreadPct` is
 * a fraction (`(ask - bid) / ask`), while `WeeklyBand.spreadPct` and
 * `BandEconomics.marginPct` are multiplied by 100 at the source. Passing a band's 10.48
 * through `formatPercent` renders "1047.8%", which looks like a spectacular find rather
 * than a units mistake — exactly the class of error CLAUDE.md §8 warns about, arriving
 * through the display layer instead of the model.
 */
export function formatPercentPoints(points: number, digits = 1): string {
  if (!Number.isFinite(points)) return "—";
  return `${points.toFixed(digits)}%`;
}

/**
 * A duration in hours, at a resolution a reader can act on.
 *
 * A high-volume material clears its queue in seconds, and `(0.0015).toFixed(1)` renders
 * that as "0.0h" — which reads as *no time at all* rather than *no wait*. Below an hour the
 * unit changes; `Infinity` means the flow that would clear it is zero, and "never" is the
 * honest word for that rather than a very large number.
 */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return "never";
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const minutes = hours * 60;
  return minutes >= 1 ? `${Math.round(minutes)}m` : "<1m";
}
