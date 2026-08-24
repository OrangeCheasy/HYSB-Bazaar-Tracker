import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // packages/core is the only place coverage actually matters — it is the pure
    // domain layer, and the one part of this project worth reusing elsewhere.
    include: ["packages/core/test/**/*.test.ts"],
    coverage: {
      include: ["packages/core/src/**/*.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
