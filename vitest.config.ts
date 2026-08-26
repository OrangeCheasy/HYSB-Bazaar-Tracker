import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@core/*" path mapping — TS resolves that at typecheck
    // time, but vitest's own module resolver needs the same alias to run src/worker
    // tests that import packages/core via "@core/..." instead of a relative path.
    alias: {
      "@core": fileURLToPath(new URL("./packages/core/src", import.meta.url)),
    },
  },
  test: {
    // src/worker tests are unit tests over pure logic (tier assignment, param-count
    // chunking, SQL builders) run against fake D1 stubs — not live-D1 integration tests.
    // Those live in scripts/db-smoke.sh against a real local SQLite engine instead.
    include: [
      "packages/core/test/**/*.test.ts",
      "src/worker/**/*.test.ts",
      // web/ ships one test file: the settings schema, deliberately kept DOM-free so it
      // runs here in node rather than needing a jsdom environment and testing-library
      // for what is really validation and unit-conversion logic.
      "web/src/**/*.test.ts",
    ],
    coverage: {
      // packages/core is the only place coverage actually matters — it is the pure
      // domain layer, and the one part of this project worth reusing elsewhere. Worker
      // code is glue (fetch, D1, R2) that the coverage bar was never meant to cover.
      include: ["packages/core/src/**/*.ts"],
      // ROADMAP Phase 1 asks for >90% on packages/core. Branches sat at 85 because the
      // domain code carried impossible-but-uncoverable fallbacks; those were structured
      // out rather than tested around, so the bar now matches the stated goal on every
      // metric. What remains uncovered is a handful of defensive non-finite guards.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
