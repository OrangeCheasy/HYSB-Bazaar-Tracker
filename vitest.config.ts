import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // packages/core is the only place coverage actually matters — it is the pure
    // domain layer, and the one part of this project worth reusing elsewhere.
    include: ["packages/core/test/**/*.test.ts"],
    coverage: {
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
