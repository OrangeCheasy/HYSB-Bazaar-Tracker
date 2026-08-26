import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", ".wrangler/**", "node_modules/**", "coverage/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // packages/core is platform-free by contract. This is the rule that enforces it,
  // rather than trusting everyone to remember. See CLAUDE.md §4.
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "packages/core takes data as arguments. No I/O." },
        { name: "process", message: "packages/core must not import from node:*." },
        { name: "caches", message: "packages/core must stay platform-free." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["cloudflare:*"], message: "packages/core must stay platform-free." },
            { group: ["node:*"], message: "packages/core must stay platform-free." },
            { group: ["../../../src/*"], message: "packages/core must not import the Worker." },
          ],
        },
      ],
    },
  },

  // The rules of hooks are not style — a missing dependency here is a stale closure
  // serving numbers from the previous settings, which on this site means showing a margin
  // computed at a tax rate the user has already changed.
  { ...reactHooks.configs.flat["recommended-latest"], files: ["web/src/**/*.{ts,tsx}"] },

  {
    // `web/src` only — `web/vite.config.ts` is build tooling that runs in node, and gets
    // its own block below.
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The mirror of the packages/core rule above, and the reason the wire types live in
      // core at all: web/ may not reach into the Worker. Anything both sides need is a
      // plain type in packages/core (CLAUDE.md §4).
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/src/worker/*", "../../src/*"],
              message:
                "web/ must not import Worker code. Shared types belong in packages/core (see wire.ts).",
            },
            {
              group: ["cloudflare:*", "node:*"],
              message: "web/ runs in a browser.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["scripts/**/*.ts", "web/vite.config.ts", "*.config.{ts,mjs}"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
