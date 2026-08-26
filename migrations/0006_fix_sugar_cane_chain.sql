-- 0006_fix_sugar_cane_chain.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- Fixes the one recipe in 0003 that was materially wrong rather than merely unverified.
--
-- 0003 seeded ('SUGAR_CANE', 'ENCHANTED_SUGAR_CANE', 160). ENCHANTED_SUGAR_CANE is a
-- tier-2 enchanted item: it is 160 ENCHANTED_SUGAR, and ENCHANTED_SUGAR is itself 160
-- sugar (sugar cane converts 1:1 to sugar). Pricing it as a single 160:1 step off raw
-- sugar cane understated the input cost by 160x, and production ranked it FIRST in
-- /api/scan at ~1.77 billion profit/day with a ~3,000% margin.
--
-- Evidence this is the right shape, not a guess. Implied price ratio
-- (ench_bid / (ratio * base_ask)) across all 42 seeded recipes landed between 0.04 and
-- 1.23 for 41 of them -- the sub-160x compression CLAUDE.md section 8 predicts from
-- Super Compactor supply. SUGAR_CANE alone was 29.05, a 24x gap to the next value.
-- Measured against a live snapshot on 2026-08-25:
--
--   SUGAR_CANE            ask     18.19
--   ENCHANTED_SUGAR       ask    674.53   bid    622.91
--   ENCHANTED_SUGAR_CANE  ask 105975.32   bid 103638.80
--
--   ENCHANTED_SUGAR_CANE bid / ENCHANTED_SUGAR ask = 103638.80 / 674.53 = 153.6
--
-- 153.6 against a 160 ratio is an implied price ratio of 0.96, which sits with
-- NETHERRACK (1.011), INK_SACK:4 (0.991) and ENCHANTED_DIAMOND (0.951) rather than out
-- on its own. The second rung prices as a textbook 160:1 compaction step.
--
-- This also matches how every other tier-2 chain in 0003 is already modelled: as two
-- rows (ENCHANTED_DIAMOND -> ENCHANTED_DIAMOND_BLOCK, ENCHANTED_GOLD ->
-- ENCHANTED_GOLD_BLOCK, and six more), not one row with a multiplied ratio. SUGAR_CANE
-- was the outlier because its tier-2 product is not named "_BLOCK".
--
-- verified stays 0 on both rows. The price data corroborates the STRUCTURE; it is not a
-- substitute for looking at a crafting grid, and CLAUDE.md section 8 is explicit that
-- ratios cannot be validated automatically. Confirm in-game and flip verified to 1.
--
-- The general fix is the cheapest-path solver in ROADMAP Phase 4.5 Part A (ADR-023),
-- which prices multi-step chains without needing each rung hand-seeded. This migration
-- stops production printing a wrong number in the meantime; it does not replace that work.

DELETE FROM recipes
 WHERE base_tag = 'SUGAR_CANE' AND ench_tag = 'ENCHANTED_SUGAR_CANE';

INSERT OR IGNORE INTO recipes (base_tag, ench_tag, ratio, verified, note) VALUES
  ('SUGAR_CANE', 'ENCHANTED_SUGAR', 160, 0,
   'Sugar cane converts 1:1 to sugar; 160 sugar make one Enchanted Sugar.'),
  ('ENCHANTED_SUGAR', 'ENCHANTED_SUGAR_CANE', 160, 0,
   'Tier-2 step. Was mis-seeded in 0003 as a single 160:1 from raw SUGAR_CANE.');
