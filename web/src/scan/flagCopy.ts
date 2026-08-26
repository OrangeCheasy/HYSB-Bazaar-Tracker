import type { WarningFlag } from "@core/index.js";

/**
 * What each warning flag means, and what to do about it.
 *
 * ROADMAP Phase 5's Done-when clause is that someone who has never seen this site can
 * explain a figure from the UI alone, and "deep buy-order queue" fails that on its own
 * terms — it names a mechanism to a reader who has no reason to know the mechanism. So
 * every entry here is written to answer one question: *given this, what should I do
 * differently?*
 *
 * Three rules the copy follows:
 *
 *   1. **Name the number that fired it.** A threshold a reader can check is a claim; a
 *      bare adjective is an opinion. The thresholds live in `packages/core/economics.ts`
 *      and are repeated here in prose, so a change there should be reflected here.
 *   2. **Say what it costs, in the terms of the trade.** Not "your order may fill slowly"
 *      but "your coins sit locked up in an unfilled order for days".
 *   3. **Offer the action, including the honest option of not trading it.** Several of
 *      these have no fix, and pretending otherwise is worse than saying so.
 *
 * Both the scan table and the craft detail page read from here, so the two cannot drift
 * into telling a user different things about the same row.
 */

export interface FlagCopy {
  /** Chip label in a dense table. Two words at most. */
  readonly short: string;
  /** One line, for the table's hover. */
  readonly summary: string;
  /** The full explanation, for the detail page. What it means, then what to do. */
  readonly detail: string;
  /** `warn` means the number is probably not real. `info` qualifies a real number. */
  readonly tone: "warn" | "info";
}

export const FLAG_COPY: Readonly<Record<WarningFlag, FlagCopy>> = {
  "implausible-margin": {
    short: "too good",
    summary: "A margin this large does not survive on a real market — check the recipe.",
    detail:
      "This craft shows a margin above 50%. Real craft spreads on the bazaar are 1-5%, because Super Compactor minions dump enchanted supply into the market continuously and arbitrage closes anything wider within hours. A margin ten times that size is almost never free money. It usually means one of three things: the recipe ratio is wrong, the item is dead and the last recorded price is meaningless, or someone is holding the book with a wall order you cannot trade through. Treat this row as a question, not an opportunity — check the ratio in game before committing coins to it.",
    tone: "warn",
  },

  "below-ratio-parity": {
    short: "below parity",
    summary: "The product sells for less than its own inputs cost at this ratio.",
    detail:
      "The enchanted product is trading below what its raw materials cost you at this recipe's ratio. That sounds impossible, and sometimes it is — a wrong ratio produces exactly this pattern. But it is also genuinely common on this market: Super Compactor 3000 minions auto-craft enchanted forms and sell them regardless of price, so popular materials really do trade under parity for long stretches. Check the ratio first. If the ratio turns out to be right, this is not a craft for you to make — it is a signal that buying the enchanted form outright is cheaper than making it, which is a perfectly good thing to know.",
    tone: "warn",
  },

  "single-sided-book": {
    short: "one-sided",
    summary: "One side of the order book is empty, so there is no market price here.",
    detail:
      "One side of this item's order book has nothing in it — no resting buy orders, or no sell offers. Every price on this row is therefore a single quote rather than a market, and nothing guarantees you can transact anywhere near it. Your order may sit unmatched indefinitely, and if it does fill it may be at a price nothing else corroborates. Wait for both sides of the book to have depth before trading this.",
    tone: "warn",
  },

  "unverified-recipe": {
    short: "unverified",
    summary: "The ratio has not been confirmed against a crafting grid.",
    detail:
      "Nobody has confirmed how many base items this craft actually consumes. Most compaction recipes are 160:1, but the exceptions are real — ender pearls are 20, eggs are 144, hard stone is 576 — and a tag name does not encode a crafting grid, so nothing here can tell the difference automatically. Every anvil merge chain is unverified for the same reason: whether each rung genuinely combines is a fact about the game, not about arithmetic. What this costs you is proportional: if the true ratio is double what is shown, you will spend twice what the cost figure says and the margin is gone. Open the recipe in game and count the inputs before you commit real coins, and treat the numbers here as a shortlist rather than a quote.",
    tone: "info",
  },

  "deep-buy-queue": {
    short: "deep queue",
    summary: "Over two days of buy orders already sit ahead of yours at this price.",
    detail:
      "There is a long line of buy orders resting at this price already — more than 48 hours' worth of the flow that fills them. Yours joins the back of that line, and it fills only after everything ahead of it does. In practice that means your coins are locked in an order that may not fill for days, while the price you were counting on moves. You have two options: bid above the queue to jump it, which costs you part of the margin shown here, or pick something less crowded. The profit figure on this row assumes you got filled, so treat it as conditional on winning that queue.",
    tone: "info",
  },

  "product-rarely-instant-bought": {
    short: "rarely bought",
    summary: "Almost nobody instant-buys this, and instant-buys are what fill your sell offer.",
    detail:
      "Fewer than one unit an hour gets instant-bought out of this product's book, and instant-buys are the only thing that fills a sell offer. You can make this craft; the question is who takes it off you. Expect the offer to rest for days, and expect to be undercut while it does. The profit-per-day figure assumes a sale that may simply never arrive. If you want out of a position like this quickly, you are selling into the buy orders instead, at the lower price — which is a different and usually much worse trade.",
    tone: "info",
  },

  "volatile-base": {
    short: "volatile",
    summary: "The base material's price swings more than 12% within the window.",
    detail:
      "The base material has been moving more than 12% inside the window this was measured over. That matters because your cost is fixed when your buy order fills, not now — so the margin above is a snapshot of a price that has been unstable. A swing of that size is larger than the entire margin on most crafts, which means the trade can be underwater by the time you own the material. If you trade this, buy and sell close together rather than leaving both orders resting overnight.",
    tone: "info",
  },

  "profit-needs-both-fills": {
    short: "needs both fills",
    summary: "Profitable only if BOTH your orders fill. Instant-trading it loses money.",
    detail:
      "This craft is profitable when you buy with an order and sell with an offer, and loses money if you instant-buy the materials and instant-sell the product. In other words the entire profit is the spread you capture by waiting, not by crafting. Both orders have to fill for the number above to be real, and if you get impatient on either side you have converted a winning trade into a losing one. This is the flag to take most seriously on an otherwise healthy-looking row.",
    tone: "info",
  },

  "slow-fill": {
    short: "slow fill",
    summary: "Over 14 hours of market flow to accumulate a single craft's worth.",
    detail:
      "Accumulating enough base material for even one craft takes more than 14 hours at the rate this item actually trades. The profit-per-day figure already accounts for that, which is why it may look small next to the margin — but the practical consequence is worth stating plainly: this is not something you set up and collect from tonight. Capital goes in and comes back slowly. Compare its profit per day against a faster craft before choosing it, rather than comparing margins.",
    tone: "info",
  },

  "wide-spread": {
    short: "wide spread",
    summary: "Over 15% between bid and ask, so the mid price means very little.",
    detail:
      "The gap between the highest buy order and the lowest sell offer is more than 15% of the price. On a tight market that gap is a fraction of a percent, so a spread this wide means there is little agreement about what the item is worth. The consequence for you is that the price you actually transact at could be far from any average shown, and the difference is larger than the margin on most crafts. Read the buy and sell numbers on this row separately rather than trusting anything in the middle.",
    tone: "info",
  },

  "stale-data": {
    short: "stale",
    summary: "The freshest data behind this row is over three hours old.",
    detail:
      "Nothing has been recorded for this item in more than three hours, so every figure here describes a market that has had time to move without you. Thinly traded items go quiet for long stretches quite normally, so this is not necessarily a fault in the collection — but it does mean the prices above are a memory rather than a quote, and an order you place against them may be badly mispriced the moment it lands. Check the current book in game before acting on this row, and glance at the freshness indicator in the header to see whether the gap is this one item or the whole site.",
    tone: "info",
  },
};

/** Flags that mean "this number is probably not real". Used for demotion and emphasis. */
export function isWarnFlag(flag: WarningFlag): boolean {
  return FLAG_COPY[flag].tone === "warn";
}
