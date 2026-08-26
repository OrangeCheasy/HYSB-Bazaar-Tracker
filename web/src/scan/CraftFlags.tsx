import type { WarningFlag } from "@core/index.js";
import { FLAG_COPY } from "./flagCopy.js";

/**
 * Flag chips for a dense table row. The copy lives in `flagCopy.ts`, shared with the
 * detail page so the two cannot tell a user different things about the same row.
 */
/** Chips beyond this collapse into a count on a narrow screen. Three flags is common —
 *  `deep queue`, `rarely bought`, `slow fill` all fire together on a thin book — and at
 *  375px that wrapped onto a line of its own, turning a two-line row into three and
 *  costing the density the mobile layout exists for. */
const MOBILE_CHIP_LIMIT = 2;

export function CraftFlags({
  flags,
}: {
  readonly flags: readonly WarningFlag[];
}): React.JSX.Element | null {
  // `unverified-recipe` is handled by the recipe cell's own marking rather than a chip:
  // every recipe carries it, so a chip on every row would be wallpaper while the rule
  // needs the marking to actually register.
  const shown = flags.filter((flag) => flag !== "unverified-recipe");
  if (shown.length === 0) return null;

  // Warnings first, so the chip that survives the mobile cut is the one that matters.
  const ordered = [...shown].sort(
    (a, b) => (FLAG_COPY[a].tone === "warn" ? 0 : 1) - (FLAG_COPY[b].tone === "warn" ? 0 : 1),
  );
  const hidden = ordered.slice(MOBILE_CHIP_LIMIT);

  return (
    <span className="inline-flex flex-wrap gap-1">
      {ordered.map((flag, index) => {
        const copy = FLAG_COPY[flag];
        return (
          <span
            key={flag}
            title={copy.summary}
            className={`rounded-sm border px-1 text-[10px] leading-4 ${
              // Chips past the limit are hidden only on a narrow screen; a desktop row has
              // the width for all of them.
              index >= MOBILE_CHIP_LIMIT ? "hidden sm:inline" : ""
            } ${
              copy.tone === "warn"
                ? "border-outage/40 text-outage"
                : "border-rule-strong text-ink-faint"
            }`}
          >
            {copy.short}
          </span>
        );
      })}
      {hidden.length > 0 && (
        <span
          className="rounded-sm border border-rule-strong px-1 text-[10px] leading-4 text-ink-faint sm:hidden"
          // The hidden ones are named, not merely counted — "+2" that a reader cannot
          // resolve is worse than no chip at all.
          title={hidden.map((flag) => FLAG_COPY[flag].summary).join("\n\n")}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

/**
 * The full explanations, for a detail page that has room for them.
 *
 * Warnings first, because a row whose numbers are probably not real is a different kind of
 * problem from one whose real numbers need a caveat — and a reader who stops after the
 * first paragraph should have read the one that changes their mind.
 */
export function FlagExplanations({
  flags,
}: {
  readonly flags: readonly WarningFlag[];
}): React.JSX.Element | null {
  if (flags.length === 0) return null;

  const ordered = [...flags].sort((a, b) => {
    const rank = (f: WarningFlag): number => (FLAG_COPY[f].tone === "warn" ? 0 : 1);
    return rank(a) - rank(b);
  });

  return (
    <div className="space-y-3">
      {ordered.map((flag) => {
        const copy = FLAG_COPY[flag];
        return (
          <div
            key={flag}
            className={`border-l-2 pl-3 ${
              copy.tone === "warn" ? "border-outage" : "border-rule-strong"
            }`}
          >
            <h3
              className={`text-xs font-semibold tracking-wide uppercase ${
                copy.tone === "warn" ? "text-outage" : "text-ink-dim"
              }`}
            >
              {copy.short}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-ink-dim">{copy.detail}</p>
          </div>
        );
      })}
    </div>
  );
}
