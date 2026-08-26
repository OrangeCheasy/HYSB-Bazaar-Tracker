import {
  BAND_PARAM_RANGES,
  DEFAULT_BAND_QUERY,
  DEFAULT_SCAN_QUERY,
  SCAN_PARAM_RANGES,
  checkParamValue,
  type ParamRange,
} from "@core/index.js";

/**
 * The settings a user can change, and the rules for what a valid one is.
 *
 * Deliberately free of `window`, `localStorage` and React so it can be tested under the
 * repo's existing node-env vitest without jsdom. Persistence lives in `store.ts`;
 * query-string assembly in `toQuery.ts`.
 *
 * Every bound here is read from `packages/core/src/params.ts` — the same table the Worker
 * rejects requests with. Hand-writing a second copy would let the drawer save a value the
 * API answers with a 400, which is the failure this whole arrangement exists to prevent.
 */

/** Bumped only when a stored payload can no longer be read. `migrate` handles the rest. */
export const SETTINGS_VERSION = 1;

export interface Settings {
  readonly version: number;

  /** Bazaar sell tax as a fraction: 1.25% base, 1% with Bazaar Flipper II, ~2.25% under
   *  Mayor Aura. Adjustable rather than constant because the mayor changes it
   *  (CLAUDE.md §8). Applies to sell offers only, never to buying. */
  readonly taxRate: number;
  /** How much of observed market volume you assume you can take. */
  readonly captureFraction: number;
  /** Price step used when undercutting. */
  readonly tick: number;

  /** Buy band percentile — p10 of hourly bid_avg by default. */
  readonly lowPercentile: number;
  /** Sell band percentile — p90 of hourly ask_avg by default. */
  readonly highPercentile: number;
  /** Trailing window the band is computed over, in days. */
  readonly windowDays: number;

  /**
   * The overnight hours an order rests unattended, in the USER'S timezone.
   *
   * The API takes these as UTC (sleepStart/sleepEnd, 0-23 UTC) but nobody thinks about
   * their own sleep in UTC, so they are stored local and converted at query-build time.
   * Storing UTC instead would silently shift a user's window twice a year when their
   * offset changes, and would profile the wrong eight hours the moment they travel.
   */
  readonly sleepStartLocal: number;
  readonly sleepEndLocal: number;

  /** Length of the searched sell window in hours; the search picks WHEN. */
  readonly sellWindowHours: number;

  /** Coins available. `null` means no constraint, which is a DIFFERENT scan from one
   *  constrained to 0 — the API distinguishes them by the parameter's absence. */
  readonly capital: number | null;

  /** IANA zone. All timestamps are stored UTC and converted here (CLAUDE.md §5). */
  readonly timeZone: string;
}

/** The user's zone, or UTC where `Intl` cannot say. */
export function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Whole-hour offset from UTC, e.g. +2 for Berlin in summer. Zones on a :30 or :45 offset
 *  round toward UTC — the sleep window is an hour-resolution control and the API
 *  parameter is an integer hour, so a half-hour zone cannot be represented either way. */
export function utcOffsetHours(at: Date = new Date()): number {
  return Math.trunc(-at.getTimezoneOffset() / 60);
}

export function wrapHour(hour: number): number {
  return ((Math.trunc(hour) % 24) + 24) % 24;
}

/**
 * Defaults match the API's defaults exactly, which is not cosmetic: `/api/scan` and
 * `/api/bands` only take their single-KV-read fast path when every parameter equals the
 * default, so a drawer that defaulted to 0.0126 tax would quietly push every visitor onto
 * the live-D1 path.
 *
 * The sleep hours are the exception — the API's 23/07 are UTC and these are local, so
 * they are shifted here and shifted back by `toQuery`. For a UTC user the round trip is
 * the identity, which is what keeps the fast path reachable.
 */
export function defaultSettings(offsetHours: number = utcOffsetHours()): Settings {
  return {
    version: SETTINGS_VERSION,
    taxRate: DEFAULT_SCAN_QUERY.tax,
    captureFraction: DEFAULT_SCAN_QUERY.capture,
    tick: DEFAULT_SCAN_QUERY.tick,
    lowPercentile: DEFAULT_BAND_QUERY.pLow,
    highPercentile: DEFAULT_BAND_QUERY.pHigh,
    windowDays: DEFAULT_BAND_QUERY.days,
    sleepStartLocal: wrapHour(DEFAULT_SCAN_QUERY.sleepStart + offsetHours),
    sleepEndLocal: wrapHour(DEFAULT_SCAN_QUERY.sleepEnd + offsetHours),
    sellWindowHours: DEFAULT_SCAN_QUERY.window,
    capital: null,
    timeZone: resolveTimeZone(),
  };
}

/** Which core range validates each field. The two hour fields are absent: `wrapHour`
 *  makes them 0-23 by construction, so there is no invalid value to reject. */
const FIELD_RANGES: Readonly<Partial<Record<keyof Settings, readonly [string, ParamRange]>>> = {
  taxRate: ["tax", SCAN_PARAM_RANGES.tax],
  captureFraction: ["capture", SCAN_PARAM_RANGES.capture],
  tick: ["tick", SCAN_PARAM_RANGES.tick],
  sellWindowHours: ["window", SCAN_PARAM_RANGES.window],
  capital: ["capital", SCAN_PARAM_RANGES.capital],
  windowDays: ["days", BAND_PARAM_RANGES.days],
  lowPercentile: ["pLow", BAND_PARAM_RANGES.pLow],
  highPercentile: ["pHigh", BAND_PARAM_RANGES.pHigh],
};

/** Null when the field is fine, otherwise the message to show under the input — the same
 *  sentence the API would have returned for the same value. */
export function validateField(field: keyof Settings, value: number | null): string | null {
  // Absent capital is valid and meaningful; absent anything else is not a state the
  // drawer can produce.
  if (field === "capital" && value === null) return null;
  const entry = FIELD_RANGES[field];
  if (entry === undefined || value === null) return null;
  const [name, range] = entry;
  const checked = checkParamValue(name, range, value);
  return checked.ok ? null : checked.message;
}

export type SettingsErrors = Readonly<Partial<Record<keyof Settings, string>>>;

/** Every field's message, keyed by field. An empty object means these settings are
 *  sendable — nothing here can produce a 400. */
export function validate(settings: Settings): SettingsErrors {
  const errors: Partial<Record<keyof Settings, string>> = {};
  for (const field of Object.keys(FIELD_RANGES) as (keyof Settings)[]) {
    const value = settings[field];
    const message = validateField(field, typeof value === "number" ? value : null);
    if (message !== null) errors[field] = message;
  }
  // Not a range check, so it is not in the table: the buy band must sit under the sell
  // band or the strategy is inverted, and the API rejects the pair for the same reason.
  //
  // Only when neither percentile already has a range error, which is what the Worker does
  // — `parseBandParams` checks ranges first and returns on the first failure. `pLow=10`
  // means "the 10th percentile, written wrong", and "must be a fraction, so p10 is 0.1"
  // is the message that fixes it; "must sit below the sell band" would send the user off
  // to change the wrong field.
  if (
    errors.lowPercentile === undefined &&
    errors.highPercentile === undefined &&
    settings.lowPercentile >= settings.highPercentile
  ) {
    errors.lowPercentile = `the buy band (${settings.lowPercentile}) must sit below the sell band (${settings.highPercentile})`;
  }
  return errors;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Read whatever is in storage into a valid `Settings`, field by field.
 *
 * Deliberately not all-or-nothing: a payload written by an older build is missing fields
 * rather than wrong, and discarding the whole object would throw away a user's tax rate
 * because a percentile was added later. Anything unreadable falls back to the default for
 * that field alone.
 */
export function migrate(raw: unknown, offsetHours: number = utcOffsetHours()): Settings {
  const base = defaultSettings(offsetHours);
  if (typeof raw !== "object" || raw === null) return base;
  const stored = raw as Partial<Record<keyof Settings, unknown>>;

  const merged: Settings = {
    version: SETTINGS_VERSION,
    taxRate: num(stored.taxRate, base.taxRate),
    captureFraction: num(stored.captureFraction, base.captureFraction),
    tick: num(stored.tick, base.tick),
    lowPercentile: num(stored.lowPercentile, base.lowPercentile),
    highPercentile: num(stored.highPercentile, base.highPercentile),
    windowDays: num(stored.windowDays, base.windowDays),
    sleepStartLocal: wrapHour(num(stored.sleepStartLocal, base.sleepStartLocal)),
    sleepEndLocal: wrapHour(num(stored.sleepEndLocal, base.sleepEndLocal)),
    sellWindowHours: num(stored.sellWindowHours, base.sellWindowHours),
    capital:
      stored.capital === null || stored.capital === undefined
        ? base.capital
        : num(stored.capital, 0),
    timeZone:
      typeof stored.timeZone === "string" && stored.timeZone !== ""
        ? stored.timeZone
        : base.timeZone,
  };

  // A stored value can be out of range even though it was in range when written, if a
  // core bound has tightened since. Reset just those fields rather than keeping a payload
  // the API will now reject.
  const errors = validate(merged);
  if (Object.keys(errors).length === 0) return merged;
  const repaired: Record<string, unknown> = { ...merged };
  for (const field of Object.keys(errors)) repaired[field] = base[field as keyof Settings];
  return repaired as unknown as Settings;
}
