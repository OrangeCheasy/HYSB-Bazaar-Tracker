import { DEFAULT_BAND_QUERY, DEFAULT_SCAN_QUERY } from "@core/index.js";
import { utcOffsetHours, wrapHour, type Settings } from "./schema.js";

/**
 * Settings to query string.
 *
 * Two rules do all the work here.
 *
 * **The sleep window is local in the UI and UTC on the wire.** `?sleepStart`/`?sleepEnd`
 * are hours 0-23 UTC; the drawer shows the user's own hours. Converting in one place
 * means no component can forget, and nothing else in the app has to know the parameter
 * is UTC at all.
 *
 * **A parameter equal to the default is omitted, never sent.** `/api/scan` and
 * `/api/bands` serve a single precomputed KV read only when every parameter is absent or
 * exactly default; sending `?tax=0.0125` explicitly is the same number but takes the live
 * D1 path, so spelling out the defaults would cost every default visitor the fast path
 * for nothing. It also keeps shared links short and readable.
 */

function put(sp: URLSearchParams, key: string, value: number, fallback: number): void {
  if (value !== fallback) sp.set(key, String(value));
}

/** Scan and craft parameters: `?tax=&capture=&tick=&sleepStart=&sleepEnd=&window=&capital=` */
export function toScanQuery(
  settings: Settings,
  offsetHours: number = utcOffsetHours(),
): URLSearchParams {
  const sp = new URLSearchParams();
  put(sp, "tax", settings.taxRate, DEFAULT_SCAN_QUERY.tax);
  put(sp, "capture", settings.captureFraction, DEFAULT_SCAN_QUERY.capture);
  put(sp, "tick", settings.tick, DEFAULT_SCAN_QUERY.tick);
  put(sp, "window", settings.sellWindowHours, DEFAULT_SCAN_QUERY.window);

  put(
    sp,
    "sleepStart",
    wrapHour(settings.sleepStartLocal - offsetHours),
    DEFAULT_SCAN_QUERY.sleepStart,
  );
  put(
    sp,
    "sleepEnd",
    wrapHour(settings.sleepEndLocal - offsetHours),
    DEFAULT_SCAN_QUERY.sleepEnd,
  );

  // Absence is the "no constraint" signal — a different scan from one constrained to 0
  // coins — so an unset capital must not become `capital=0`.
  if (settings.capital !== null) sp.set("capital", String(settings.capital));

  return sp;
}

/** Band parameters: `?days=&pLow=&pHigh=` */
export function toBandQuery(settings: Settings): URLSearchParams {
  const sp = new URLSearchParams();
  put(sp, "days", settings.windowDays, DEFAULT_BAND_QUERY.days);
  put(sp, "pLow", settings.lowPercentile, DEFAULT_BAND_QUERY.pLow);
  put(sp, "pHigh", settings.highPercentile, DEFAULT_BAND_QUERY.pHigh);
  return sp;
}

/** `?a=1&b=2` with a leading `?`, or an empty string — appendable to any path. */
export function queryString(sp: URLSearchParams): string {
  const s = sp.toString();
  return s === "" ? "" : `?${s}`;
}
