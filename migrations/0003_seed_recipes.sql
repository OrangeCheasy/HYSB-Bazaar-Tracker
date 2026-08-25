-- 0003_seed_recipes.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- Seeds the 42 hand-curated recipes from config.json (repo root, the Python reference
-- tool's config). A migration rather than a runtime seed step: recipes rarely change,
-- and this keeps them declarative and versioned alongside the schema instead of adding a
-- second seed-script code path that is neither the Worker nor scripts/.
--
-- verified = 0 (false) for every row. Tag EXISTENCE was cross-checked against a live
-- Hypixel bazaar response during Phase 2 (see below); crafting RATIO cannot be — name
-- matching cannot see a crafting grid, per packages/core/src/recipes.ts's own doc
-- comment. Confirm each ratio in-game and flip verified to 1 as you go.
--
-- Two corrections made against config.json during that cross-check, both worth a note
-- since future-you will otherwise assume this table is a faithful copy of that file:
--   1. config.json has 'ENCHANTED_LAPIS_BLOCK', which does not exist as a Hypixel
--      product tag -> corrected here to 'ENCHANTED_LAPIS_LAZULI_BLOCK', confirmed
--      present in a live bazaar response.
--   2. 'INK_SACK:4' looked like stale pre-Hypixel-API Minecraft colon-notation and was
--      flagged as a likely-dead tag while this migration was drafted — but it IS a real,
--      live Hypixel product tag (confirmed against the same live response), so it is
--      kept as-is.
--
-- Tier assignment (src/worker/db/tiers.ts, Phase 2) must union base_tag AND ench_tag
-- across every row below, not base_tag alone: eight rows here have a base_tag that is
-- itself another row's ench_tag (the tier-2 crafts, e.g. ENCHANTED_COAL is both the
-- ench_tag of the coal recipe and the base_tag of the enchanted-coal-block recipe).
-- Missing that union silently drops those eight tags to Tier B.

INSERT INTO recipes (base_tag, ench_tag, ratio, verified, note) VALUES
  ('COBBLESTONE', 'ENCHANTED_COBBLESTONE', 160, 0, NULL),
  ('COAL', 'ENCHANTED_COAL', 160, 0, NULL),
  ('IRON_INGOT', 'ENCHANTED_IRON', 160, 0, NULL),
  ('GOLD_INGOT', 'ENCHANTED_GOLD', 160, 0, NULL),
  ('DIAMOND', 'ENCHANTED_DIAMOND', 160, 0, NULL),
  ('INK_SACK:4', 'ENCHANTED_LAPIS_LAZULI', 160, 0, NULL),
  ('REDSTONE', 'ENCHANTED_REDSTONE', 160, 0, NULL),
  ('EMERALD', 'ENCHANTED_EMERALD', 160, 0, NULL),
  ('QUARTZ', 'ENCHANTED_QUARTZ', 160, 0, NULL),
  ('OBSIDIAN', 'ENCHANTED_OBSIDIAN', 160, 0, NULL),
  ('GLOWSTONE_DUST', 'ENCHANTED_GLOWSTONE_DUST', 160, 0, NULL),
  ('ICE', 'ENCHANTED_ICE', 160, 0, NULL),
  ('SAND', 'ENCHANTED_SAND', 160, 0, NULL),
  ('NETHERRACK', 'ENCHANTED_NETHERRACK', 160, 0, NULL),
  ('ENDER_STONE', 'ENCHANTED_ENDSTONE', 160, 0, NULL),
  ('MITHRIL_ORE', 'ENCHANTED_MITHRIL', 160, 0, NULL),
  ('TITANIUM_ORE', 'ENCHANTED_TITANIUM', 160, 0, NULL),
  ('STRING', 'ENCHANTED_STRING', 160, 0, NULL),
  ('BONE', 'ENCHANTED_BONE', 160, 0, NULL),
  ('SLIME_BALL', 'ENCHANTED_SLIME_BALL', 160, 0, NULL),
  ('ROTTEN_FLESH', 'ENCHANTED_ROTTEN_FLESH', 160, 0, NULL),
  ('SPIDER_EYE', 'ENCHANTED_SPIDER_EYE', 160, 0, NULL),
  ('SULPHUR', 'ENCHANTED_SULPHUR', 160, 0, NULL),
  ('POTATO_ITEM', 'ENCHANTED_POTATO', 160, 0, NULL),
  ('CARROT_ITEM', 'ENCHANTED_CARROT', 160, 0, NULL),
  ('MELON', 'ENCHANTED_MELON', 160, 0, NULL),
  ('PUMPKIN', 'ENCHANTED_PUMPKIN', 160, 0, NULL),
  ('SUGAR_CANE', 'ENCHANTED_SUGAR_CANE', 160, 0, NULL),
  ('RAW_FISH', 'ENCHANTED_RAW_FISH', 160, 0, NULL),
  ('PORK', 'ENCHANTED_PORK', 160, 0, NULL),
  ('RAW_CHICKEN', 'ENCHANTED_RAW_CHICKEN', 160, 0, NULL),
  ('ENDER_PEARL', 'ENCHANTED_ENDER_PEARL', 20, 0, 'exception: ender pearls stack to 16, so the recipe is 20 not 160'),
  ('EGG', 'ENCHANTED_EGG', 144, 0, 'exception: 144, not 160'),
  ('HARD_STONE', 'ENCHANTED_HARD_STONE', 576, 0, 'exception: 576'),
  ('ENCHANTED_COAL', 'ENCHANTED_COAL_BLOCK', 160, 0, 'tier 2 craft'),
  ('ENCHANTED_IRON', 'ENCHANTED_IRON_BLOCK', 160, 0, 'tier 2 craft'),
  ('ENCHANTED_GOLD', 'ENCHANTED_GOLD_BLOCK', 160, 0, 'tier 2 craft'),
  ('ENCHANTED_DIAMOND', 'ENCHANTED_DIAMOND_BLOCK', 160, 0, 'tier 2 craft'),
  ('ENCHANTED_REDSTONE', 'ENCHANTED_REDSTONE_BLOCK', 160, 0, 'tier 2 craft'),
  ('ENCHANTED_EMERALD', 'ENCHANTED_EMERALD_BLOCK', 160, 0, 'tier 2 craft'),
  ('ENCHANTED_LAPIS_LAZULI', 'ENCHANTED_LAPIS_LAZULI_BLOCK', 160, 0, 'tier 2 craft'),
  ('ENCHANTED_QUARTZ', 'ENCHANTED_QUARTZ_BLOCK', 160, 0, 'tier 2 craft');
