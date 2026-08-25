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
    const env = makeFakeEnv({ kv: makeFakeKV({}), db: makeQueuedFakeD1({ all: [[]] }) });

    const res = await handleScan(new URL("https://bazaar.example/api/scan"), env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: unknown; meta: { source: string; generatedAt: number } };
    expect(body.meta.source).toBe("d1");
    expect(body.data).toEqual([]);
  });
});
