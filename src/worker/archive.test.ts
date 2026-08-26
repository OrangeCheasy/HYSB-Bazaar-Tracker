import { describe, expect, it } from "vitest";
import { pruneArchiveExpired } from "./archive.js";
import type { Env } from "./index.js";

/**
 * Minimal in-memory R2 stand-in. Only the surface pruneArchiveExpired touches: a
 * delimited list to enumerate date folders, a plain list to page objects, and a batched
 * delete. `pageSize` exists so the truncation/cursor path gets exercised rather than
 * assumed — a fake that always returns everything in one page would never catch a
 * cursor bug, which is the whole reason the loops are there.
 */
function makeFakeR2(keys: readonly string[], pageSize = 1000) {
  const store = new Set(keys);
  const deleteCalls: string[][] = [];

  const bucket = {
    list(opts?: { prefix?: string; delimiter?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const matching = [...store].filter((k) => k.startsWith(prefix)).sort();

      if (opts?.delimiter) {
        const prefixes = new Set<string>();
        const objects: { key: string; size: number }[] = [];
        for (const key of matching) {
          const rest = key.slice(prefix.length);
          const idx = rest.indexOf(opts.delimiter);
          if (idx === -1) objects.push({ key, size: 1 });
          else prefixes.add(prefix + rest.slice(0, idx + 1));
        }
        const all = [...prefixes].sort();
        const start = opts.cursor ? Number(opts.cursor) : 0;
        const page = all.slice(start, start + pageSize);
        const truncated = start + pageSize < all.length;
        return Promise.resolve({
          objects,
          delimitedPrefixes: page,
          truncated,
          cursor: truncated ? String(start + pageSize) : undefined,
        });
      }

      const start = opts?.cursor ? Number(opts.cursor) : 0;
      const page = matching.slice(start, start + pageSize);
      const truncated = start + pageSize < matching.length;
      return Promise.resolve({
        objects: page.map((key) => ({ key, size: 1 })),
        delimitedPrefixes: [],
        truncated,
        cursor: truncated ? String(start + pageSize) : undefined,
      });
    },
    delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      deleteCalls.push(list);
      for (const k of list) store.delete(k);
      return Promise.resolve();
    },
  };

  return { env: { ARCHIVE: bucket } as unknown as Env, store, deleteCalls };
}

const NOW = Math.floor(Date.UTC(2026, 8, 30, 4, 23, 0) / 1000); // 2026-09-30T04:23:00Z
const DAY = 86_400;

/** Every tick key for one date, as ingest would have written them. */
function dayKeys(date: string, ticks = 3): string[] {
  return Array.from(
    { length: ticks },
    (_, i) => `archive/${date}/${String(i).padStart(4, "0")}.json.gz`,
  );
}

function dateNDaysBefore(n: number): string {
  return new Date((NOW - n * DAY) * 1000).toISOString().slice(0, 10);
}

describe("pruneArchiveExpired", () => {
  it("deletes dates past 30 days and keeps everything inside the window", async () => {
    const fresh = dateNDaysBefore(1);
    const edge = dateNDaysBefore(29);
    const stale = dateNDaysBefore(45);

    const { env, store } = makeFakeR2([...dayKeys(fresh), ...dayKeys(edge), ...dayKeys(stale)]);

    const result = await pruneArchiveExpired(env, NOW);

    expect(result.datesRemoved).toBe(1);
    expect(result.deleted).toBe(3);
    expect(result.moreRemaining).toBe(false);
    expect([...store].some((k) => k.includes(stale))).toBe(false);
    expect([...store].some((k) => k.includes(fresh))).toBe(true);
    expect([...store].some((k) => k.includes(edge))).toBe(true);
  });

  it("keeps the day exactly at the retention boundary, deletes the one past it", async () => {
    // The cap is "30 days retained". Day 30 is the cutoff itself and survives; day 31
    // is the first that must go. An off-by-one here silently shortens retention.
    const at = dateNDaysBefore(30);
    const past = dateNDaysBefore(31);

    const { env, store } = makeFakeR2([...dayKeys(at), ...dayKeys(past)]);
    await pruneArchiveExpired(env, NOW);

    expect([...store].some((k) => k.includes(at))).toBe(true);
    expect([...store].some((k) => k.includes(past))).toBe(false);
  });

  it("caps dates per run, clears the oldest first, and reports moreRemaining", async () => {
    // 14 expired dates against a cap of 10: a long outage must not turn the recovery
    // run into an unbounded job, and the next run has to know to continue.
    const expired = Array.from({ length: 14 }, (_, i) => dateNDaysBefore(31 + i));
    const { env, store } = makeFakeR2(expired.flatMap((d) => dayKeys(d, 2)));

    const result = await pruneArchiveExpired(env, NOW);

    expect(result.datesRemoved).toBe(10);
    expect(result.deleted).toBe(20);
    expect(result.moreRemaining).toBe(true);

    // Oldest first: the 4 survivors are the *newest* of the expired set, i.e. days
    // 31-34, not an arbitrary 4. A run that cleared newest-first would leave the worst
    // offenders behind forever.
    const survivors = expired.filter((d) => [...store].some((k) => k.includes(d)));
    expect(survivors.sort()).toEqual(expired.slice(0, 4).sort());
  });

  it("pages through a truncated object listing rather than deleting one page", async () => {
    const stale = dateNDaysBefore(40);
    const { env, store, deleteCalls } = makeFakeR2(dayKeys(stale, 25), 10);

    const result = await pruneArchiveExpired(env, NOW);

    expect(result.deleted).toBe(25);
    expect(deleteCalls.length).toBeGreaterThan(1); // proves the cursor loop ran
    expect(store.size).toBe(0);
  });

  it("is a no-op on an empty bucket and on a bucket with nothing expired", async () => {
    const empty = makeFakeR2([]);
    expect(await pruneArchiveExpired(empty.env, NOW)).toEqual({
      datesRemoved: 0,
      deleted: 0,
      moreRemaining: false,
    });

    const allFresh = makeFakeR2(dayKeys(dateNDaysBefore(2)));
    const result = await pruneArchiveExpired(allFresh.env, NOW);
    expect(result.deleted).toBe(0);
    expect(allFresh.deleteCalls).toEqual([]);
  });
});
