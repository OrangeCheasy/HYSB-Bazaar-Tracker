import type { WarningFlag } from "@core/index.js";

/**
 * The eleven craft warning flags, in plain language.
 *
 * ROADMAP Phase 5 asks for "flag explanations in plain language" and the Done-when clause
 * is that someone who has never seen the site can explain what a figure means from the UI
 * alone. So each line says the consequence, not the mechanism: "someone may be walling
 * this" rather than "marginPct > 0.5".
 */

interface FlagCopy {
  readonly short: string;
  readonly title: string;
  /** `warn` means the number is probably not real. `info` qualifies a real number. */
  readonly tone: "warn" | "info";
}

const COPY: Readonly<Record<WarningFlag, FlagCopy>> = {
  "implausible-margin": {
    short: "too good",
    title:
      "A margin this large does not survive on a market where real craft spreads are 1-5%. Far more likely: the recipe ratio is wrong, the item is dead, or someone is walling the book.",
    tone: "warn",
  },
  "below-ratio-parity": {
    short: "below parity",
    title:
      "The product sells for less than its inputs cost at this ratio. Super Compactor minions dump enchanted forms in continuously, so popular materials really do trade below 160x — but check the ratio before acting on it.",
    tone: "warn",
  },
  "single-sided-book": {
    short: "one-sided",
    title:
      "One side of the order book is empty, so the price here is a single quote rather than a market. Nothing guarantees you can transact near it.",
    tone: "warn",
  },
  "unverified-recipe": {
    short: "unverified",
    title:
      "The ratio has not been confirmed against a crafting grid. Tag existence can be checked automatically; ratios cannot.",
    tone: "info",
  },
  "deep-buy-queue": {
    short: "deep queue",
    title:
      "A long line of buy orders sits ahead of yours, so your order fills slowly or not at all at this price.",
    tone: "info",
  },
  "product-rarely-instant-bought": {
    short: "rarely bought",
    title:
      "Almost nobody instant-buys this product, and instant-buys are what fill your sell offer. The profit assumes a sale that may not come.",
    tone: "info",
  },
  "volatile-base": {
    short: "volatile",
    title:
      "The base material's price swings enough that the cost side of this craft may look quite different by the time your order fills.",
    tone: "info",
  },
  "profit-needs-both-fills": {
    short: "needs both fills",
    title:
      "This profit is the realistic case only if BOTH the buy order and the sell offer fill. Either one missing and the trade does not happen.",
    tone: "info",
  },
  "slow-fill": {
    short: "slow fill",
    title: "Accumulating one craft's worth of base material takes a long time at current flow.",
    tone: "info",
  },
  "wide-spread": {
    short: "wide spread",
    title:
      "The gap between bid and ask is unusually wide, so the price you actually get may differ a lot from the mid.",
    tone: "info",
  },
  "stale-data": {
    short: "stale",
    title:
      "The most recent data behind this row is old enough that the market may have moved since.",
    tone: "info",
  },
};

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

  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((flag) => {
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
