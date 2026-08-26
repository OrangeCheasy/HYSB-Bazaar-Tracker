import type { BandFlag } from "@core/index.js";

/**
 * Band warning flags, in plain language.
 *
 * Each of these says something a user acting on the row needs to know, so they render as
 * visible marks rather than as a colour on the row. The wording explains the consequence,
 * not the mechanism — "orders never both filled" rather than "bothHitWeeks === 0".
 */

interface FlagCopy {
  readonly short: string;
  readonly title: string;
  readonly tone: "warn" | "info";
}

const COPY: Readonly<Record<BandFlag, FlagCopy>> = {
  "short-history": {
    short: "new",
    title:
      "Fewer than four weeks of history. The band itself is fine; any multi-week claim beside it rests on small n.",
    tone: "info",
  },
  "thin-samples": {
    short: "thin",
    title:
      "Some hours were built from a fraction of their five-minute ticks, so those hourly averages are less trustworthy than the rest.",
    tone: "info",
  },
  "never-both-filled": {
    short: "never filled",
    title:
      "No complete week saw both bands touched. The spread is real; the trade has not happened once in the window.",
    tone: "warn",
  },
};

export function Flags({
  flags,
}: {
  readonly flags: readonly BandFlag[];
}): React.JSX.Element | null {
  if (flags.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.map((flag) => {
        const copy = COPY[flag];
        return (
          <span
            key={flag}
            title={copy.title}
            className={`rounded-sm border px-1 text-[10px] leading-4 ${
              copy.tone === "warn"
                ? "border-outage/40 text-outage"
                : "border-rule-strong text-ink-faint"
            }`}
          >
            {copy.short}
          </span>
        );
      })}
    </span>
  );
}
