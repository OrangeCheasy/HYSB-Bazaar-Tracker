import type { ProductsPayload } from "@core/index.js";
import { selectAllProducts } from "../db/products.js";
import type { Env } from "../index.js";
import { json } from "./index.js";

/**
 * GET /api/products — the catalogue, for the item index.
 *
 * Navigation rather than analysis, so it deliberately carries no prices: an index of ~2,100
 * products with a price each would be a scan by another name, and every figure on it would
 * need the caveats a scan's figures carry. Tag, tier and last-seen are what you need to
 * FIND something; the numbers live on the item's own page where there is room to qualify
 * them.
 *
 * That also keeps this cheap. One indexed table scan, no joins, no per-tag work — which is
 * why it can afford to be uncached-but-long-lived rather than precomputed into KV.
 */
export async function handleProducts(env: Env): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await selectAllProducts(env.DB);

  const payload: ProductsPayload = rows.map((row) => ({
    tag: row.tag,
    tier: row.tier,
    isEnchanted: row.is_enchanted !== 0,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));

  // `generatedAt` is the newest `last_seen` in the catalogue rather than the clock: this
  // list is only as current as the most recent ingest that touched it, and saying "now"
  // would claim freshness the data does not have if the cron has stopped.
  let newest = 0;
  for (const row of rows) if (row.last_seen > newest) newest = row.last_seen;
  const generatedAt = newest === 0 ? now : newest;

  return json(
    payload,
    { generatedAt, staleAfter: generatedAt + 3600, source: "d1" },
    200,
    // The catalogue changes when Hypixel adds a product, which is rare, and a tier flip is
    // not something a reader acts on within the hour. This is the least freshness-sensitive
    // route on the site.
    "public, max-age=3600",
  );
}
