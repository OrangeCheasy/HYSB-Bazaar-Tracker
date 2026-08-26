import { DEFAULT_BAND_QUERY, DEFAULT_SCAN_QUERY } from "@core/index.js";
import { describe, expect, it } from "vitest";
import { defaultSettings, migrate, validate, wrapHour, type Settings } from "./schema.js";
import { toBandQuery, toScanQuery } from "./toQuery.js";

/**
 * These run under the repo's existing node-env vitest — no jsdom, no testing-library.
 * That is why the schema is DOM-free: the logic worth testing here is validation,
 * migration and the local/UTC conversion, none of which needs a browser.
 */

/** A UTC user, so the sleep-window round trip is the identity and the defaults are
 *  directly comparable to the API's. */
const UTC = 0;

describe("defaults", () => {
  it("match the API's defaults so the KV fast path stays reachable", () => {
    const s = defaultSettings(UTC);
    expect(s.taxRate).toBe(DEFAULT_SCAN_QUERY.tax);
    expect(s.captureFraction).toBe(DEFAULT_SCAN_QUERY.capture);
    expect(s.tick).toBe(DEFAULT_SCAN_QUERY.tick);
    expect(s.sellWindowHours).toBe(DEFAULT_SCAN_QUERY.window);
    expect(s.lowPercentile).toBe(DEFAULT_BAND_QUERY.pLow);
    expect(s.highPercentile).toBe(DEFAULT_BAND_QUERY.pHigh);
    expect(s.windowDays).toBe(DEFAULT_BAND_QUERY.days);
  });

  it("leave capital unset, which is not the same as zero", () => {
    expect(defaultSettings(UTC).capital).toBeNull();
  });

  it("send no query parameters at all, so the request hits the precomputed payload", () => {
    const s = defaultSettings(UTC);
    expect(toScanQuery(s, UTC).toString()).toBe("");
    expect(toBandQuery(s).toString()).toBe("");
  });
});

describe("validate", () => {
  const base = defaultSettings(UTC);

  it("passes the defaults", () => {
    expect(validate(base)).toEqual({});
  });

  it("catches the percent-vs-fraction mistake with the API's own message", () => {
    const errors = validate({ ...base, taxRate: 1.25 });
    // The same sentence the Worker would have returned for `?tax=1.25`, because both read
    // the range from packages/core/src/params.ts.
    expect(errors.taxRate).toContain("'tax' must be between 0 and 0.5");
    expect(errors.taxRate).toContain("1.25% is 0.0125");
  });

  it("rejects a percentile given as 10 rather than 0.1", () => {
    expect(validate({ ...base, lowPercentile: 10 }).lowPercentile).toContain(
      "'pLow' must be between",
    );
  });

  it("rejects a buy band at or above the sell band", () => {
    expect(validate({ ...base, lowPercentile: 0.9 }).lowPercentile).toContain("must sit below");
    expect(validate({ ...base, lowPercentile: 0.95 }).lowPercentile).toBeDefined();
  });
});

describe("migrate", () => {
  it("falls back to defaults for anything unreadable", () => {
    expect(migrate(null, UTC)).toEqual(defaultSettings(UTC));
    expect(migrate("nonsense", UTC)).toEqual(defaultSettings(UTC));
    expect(migrate(42, UTC)).toEqual(defaultSettings(UTC));
  });

  it("keeps the fields it recognises and defaults only the ones it does not", () => {
    // A payload from a build that predates the band percentiles.
    const stored = { taxRate: 0.01, captureFraction: 0.35 };
    const migrated = migrate(stored, UTC);
    expect(migrated.taxRate).toBe(0.01);
    expect(migrated.captureFraction).toBe(0.35);
    expect(migrated.lowPercentile).toBe(DEFAULT_BAND_QUERY.pLow);
  });

  it("repairs a single out-of-range field without discarding the rest", () => {
    // A bound could tighten in core after a value was already stored.
    const migrated = migrate({ taxRate: 5, captureFraction: 0.35 }, UTC);
    expect(migrated.taxRate).toBe(DEFAULT_SCAN_QUERY.tax);
    expect(migrated.captureFraction).toBe(0.35);
    expect(validate(migrated)).toEqual({});
  });

  it("preserves an explicit zero capital, which means something different from unset", () => {
    expect(migrate({ capital: 0 }, UTC).capital).toBe(0);
    expect(migrate({ capital: null }, UTC).capital).toBeNull();
    expect(migrate({}, UTC).capital).toBeNull();
  });
});

describe("the sleep window is local in the UI and UTC on the wire", () => {
  it("shifts the default window into the user's zone", () => {
    // Berlin in summer: UTC+2, so 23:00-07:00 UTC is 01:00-09:00 local.
    const berlin = defaultSettings(2);
    expect(berlin.sleepStartLocal).toBe(1);
    expect(berlin.sleepEndLocal).toBe(9);
  });

  it("round-trips back to the API default, so a non-UTC user still hits the fast path", () => {
    for (const offset of [-11, -5, 0, 2, 9, 14]) {
      expect(toScanQuery(defaultSettings(offset), offset).toString()).toBe("");
    }
  });

  it("sends UTC hours when the user picks their own window", () => {
    // A user in UTC-5 who sleeps 23:00-07:00 local is resting orders 04:00-12:00 UTC.
    const settings: Settings = {
      ...defaultSettings(-5),
      sleepStartLocal: 23,
      sleepEndLocal: 7,
    };
    const sp = toScanQuery(settings, -5);
    expect(sp.get("sleepStart")).toBe("4");
    expect(sp.get("sleepEnd")).toBe("12");
  });

  it("wraps across midnight rather than going negative", () => {
    expect(wrapHour(-1)).toBe(23);
    expect(wrapHour(24)).toBe(0);
    expect(wrapHour(26)).toBe(2);
  });
});

describe("toQuery", () => {
  const base = defaultSettings(UTC);

  it("omits a parameter equal to the default and sends the ones that differ", () => {
    const sp = toScanQuery({ ...base, taxRate: 0.01 }, UTC);
    expect(sp.get("tax")).toBe("0.01");
    expect(sp.has("capture")).toBe(false);
  });

  it("never turns an unset capital into capital=0", () => {
    expect(toScanQuery(base, UTC).has("capital")).toBe(false);
    expect(toScanQuery({ ...base, capital: 0 }, UTC).get("capital")).toBe("0");
  });
});
