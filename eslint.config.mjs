import js from "@eslint/js";
import globals from "globals";
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

  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
    },
  },

  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
);
