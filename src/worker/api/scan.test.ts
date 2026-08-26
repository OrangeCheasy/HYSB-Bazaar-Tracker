import { describe, expect, it } from "vitest";
import { SCAN_KV_KEY } from "../precompute.js";
import { makeFakeEnv, makeFakeKV, makeQueuedFakeD1 } from "../test/apiFakes.js";
import { handleScan } from "./scan.js";

describe("handleScan — stale data", () => {
  it("serves the stored (stale) meta unchanged, rather than pretending it is fresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    // The hourly cron normally rewrites this every hour; here it has not run in 5
    // hours — well past the payload's own staleAfter, simulating exactly the outage
    // this endpoint must not paper over.
    const staleGeneratedAt = now - 5 * 3600;
    const stalePayload = {
      data: [{ recipe: { baseTag: "COAL", enchTag: "ENCHANTED_COAL" }, analysis: undefined }],
      meta: { generatedAt: staleGeneratedAt, staleAfter: staleGeneratedAt + 2 * 3600, source: "kv" },
    };

    const kv = makeFakeKV({ [SCAN_KV_KEY]: JSON.stringify(stalePayload) });
    const env = makeFakeEnv({ kv });

    const res = await handleScan(new URL("https://bazaar.example/api/scan"), env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: unknown; meta: typeof stalePayload.meta };

    // The whole point: meta is NOT regenerated to "now" just because a request came
    // in. It must be the exact meta precompute.ts stored, so a client can see
    // staleAfter is already in the past and know the cron has stopped running.
    expect(body.meta).toEqual(stalePayload.meta);
    expect(body.meta.staleAfter).toBeLessThan(now);
    expect(body.data).toEqual(stalePayload.data);
  });

  it("falls back to a live D1 compute (source: d1) when KV has never been written", async () => {
    // No SCAN_KV_KEY entry, and a zero-recipe D1 — enough to prove the fallback path
    // actually runs and stays honest (dataTo === now when nothing succeeded), without
    // needing a full recipe/hourly-data fixture just to exercise this branch.
    // Two seeded .all() responses, not one: runScan queries compaction recipes and anvil
    // recipes separately, and both return empty here.
    const env = makeFakeEnv({ kv: makeFakeKV({}), db: makeQueuedFakeD1({ all: [[], []] }) });

    const res = await handleScan(new URL("https://bazaar.example/api/scan"), env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: unknown; meta: { source: string; generatedAt: number } };
    expect(body.meta.source).toBe("d1");
    expect(body.data).toEqual([]);
  });
});

describe("handleScan — query parameter validation", () => {
  const badRequest = async (query: string) => {
    const kv = makeFakeKV({});
    const env = makeFakeEnv({ kv, db: makeQueuedFakeD1({ all: [[], []] }) });
    const res = await handleScan(new URL(`https://bazaar.example/api/scan?${query}`), env);
    const body = (await res.json()) as { error?: string };
    return { status: res.status, error: body.error ?? "" };
  };

  // The failure this exists to prevent: `tax` is a fraction, so a UI (or a user) that
  // sends "1.25" meaning 1.25% asks for a 125% sell tax. Unvalidated, that renders every
  // craft as a large, confident, wrong loss — the exact opposite of CLAUDE.md section
  // 7.6's "estimates, not advice, and never a bare number".
  it("rejects a tax rate given as a percent instead of a fraction", async () => {
    const { status, error } = await badRequest("tax=1.25");
    expect(status).toBe(400);
    expect(error).toContain("tax");
    expect(error).toContain("0.0125"); // the message names the correct form
  });

  it("rejects a negative tax rather than silently substituting the default", async () => {
    expect((await badRequest("tax=-0.5")).status).toBe(400);
  });

  it("rejects a capture fraction above 1", async () => {
    expect((await badRequest("capture=5")).status).toBe(400);
  });

  it("rejects an hour outside 0-23 and a sell window outside 1-24", async () => {
    expect((await badRequest("sleepStart=25")).status).toBe(400);
    expect((await badRequest("window=100")).status).toBe(400);
  });

  it("rejects a non-numeric value instead of falling back to the default", async () => {
    const { status, error } = await badRequest("tax=abc");
    expect(status).toBe(400);
    expect(error).toContain("must be a number");
  });

  it("accepts in-range values, including the real Mayor Aura tax of 2.25%", async () => {
    const kv = makeFakeKV({});
    const env = makeFakeEnv({ kv, db: makeQueuedFakeD1({ all: [[], []] }) });
    const res = await handleScan(
      new URL("https://bazaar.example/api/scan?tax=0.0225&capture=0.5&window=6"),
      env,
    );
    expect(res.status).toBe(200);
  });
});
