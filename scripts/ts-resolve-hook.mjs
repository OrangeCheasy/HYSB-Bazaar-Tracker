/**
 * Lets a `scripts/*.ts` file `import { ... } from "@hysb/core"` under plain Node.
 *
 * `packages/core` is authored with ESM-correct `.js` specifiers (`./result.js` pointing
 * at `result.ts`), which is what `tsc` and Vite expect. Node's `--experimental-strip-types`
 * strips types but does NOT rewrite specifiers, so it goes looking for a `result.js` that
 * was never emitted and the import fails outright.
 *
 * The alternatives were worse. Adding tsx/esbuild puts a build dependency in front of a
 * local maintenance script, and reimplementing the ask/bid derivation inside `backfill.ts`
 * would duplicate the one piece of logic CLAUDE.md section 1 says must exist exactly once.
 * A dozen lines of resolver keeps the script on the same normalizer the Worker uses.
 *
 * `registerHooks` is synchronous and in-thread, so this needs no loader thread and no
 * second file. Registered via `--import` in the `backfill` npm script.
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // A genuine .js sibling — fall through to the normal resolution below.
      }
    }
    return nextResolve(specifier, context);
  },
});
