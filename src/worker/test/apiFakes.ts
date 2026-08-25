import type { Env } from "../index.js";

/**
 * Fakes for testing API route handlers, in the same spirit as
 * src/worker/db/testHelpers.ts's `makeFakeD1` (which only covers the write side used by
 * SQL-builder tests). These cover the READ side (`.all()` / `.first()`) plus KV, so a
 * handler test can seed exactly the rows a query would return without a real D1/KV
 * instance — SQL-dialect correctness is covered separately by scripts/db-smoke.sh
 * against a real local SQLite engine, same division of labor as testHelpers.ts.
 *
 * Both queues are consumed strictly in call order, not matched against the SQL text.
 * That is only safe because every route handler under test issues its reads in a fixed,
 * known order with no real async gap between them (nothing here ever actually awaits
 * I/O) — see the call-order reasoning in each *.test.ts file that uses this.
 */
export function makeQueuedFakeD1(seed: {
  all?: readonly unknown[][];
  first?: readonly (unknown | null)[];
}): Pick<D1Database, "prepare"> {
  const allQueue = [...(seed.all ?? [])];
  const firstQueue = [...(seed.first ?? [])];

  return {
    prepare(_sql: string) {
      const stmt = {
        bind(..._args: unknown[]) {
          return stmt;
        },
        async all() {
          const results = allQueue.shift();
          if (results === undefined) {
            throw new Error("makeQueuedFakeD1: .all() called more times than seeded");
          }
          return { results } as unknown as D1Result;
        },
        async first() {
          if (firstQueue.length === 0) {
            throw new Error("makeQueuedFakeD1: .first() called more times than seeded");
          }
          return firstQueue.shift();
        },
      };
      return stmt as unknown as D1PreparedStatement;
    },
  };
}

export function makeFakeKV(
  initial: Readonly<Record<string, string>> = {},
): Pick<KVNamespace, "get" | "put"> {
  const store = new Map<string, string>(Object.entries(initial));
  // KVNamespace#get is overloaded on a `type` argument (text/json/arrayBuffer/stream);
  // a fake that only ever returns text cannot satisfy every overload's return type, so
  // it is built as a plain object and cast once here rather than fighting the overload
  // set — every handler under test only ever calls the plain `get(key)` text form.
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
  return kv as unknown as Pick<KVNamespace, "get" | "put">;
}

/** Every API route handler takes a full `Env`, but only ever touches `DB` and/or
 *  `CACHE` — the other four bindings exist so the type checker sees a real `Env`
 *  without any handler test needing to fake R2/assets/vars it never reads. */
export function makeFakeEnv(parts: {
  db?: Pick<D1Database, "prepare">;
  kv?: Pick<KVNamespace, "get" | "put">;
}): Env {
  return {
    DB: (parts.db ?? makeQueuedFakeD1({})) as unknown as D1Database,
    CACHE: (parts.kv ?? makeFakeKV()) as unknown as KVNamespace,
    ARCHIVE: undefined as unknown as R2Bucket,
    ASSETS: undefined as unknown as Fetcher,
    ENVIRONMENT: "test",
    HYPIXEL_BAZAAR_URL: "https://example.invalid/unused",
  };
}
