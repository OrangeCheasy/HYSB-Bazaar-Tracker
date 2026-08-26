-- 0008_recipe_kind.sql
-- Forward-only. Never edit an applied migration; add a new numbered file instead.
--
-- Adds the craft-type discriminator to `recipes`, for ROADMAP Phase 4.5 Part B.
--
-- 'compact'  base -> enchanted, ratio 160 (with documented exceptions), collection-gated
-- 'anvil'    two books of level N -> one of level N+1, ratio always 2, not gated
--
-- Both are edges in the same conversion graph and are priced by the same solver
-- (ADR-023); the arithmetic does not branch on this column. It exists because the two
-- have different UI, different gating, and very different fill risk — max-level books are
-- 21% of book coin turnover on 4.6% of unit volume, so a merge sells few, expensive items
-- where a compaction craft dumps many cheap ones.
--
-- Existing rows are all compaction crafts, which is why DEFAULT 'compact' is correct as a
-- backfill rather than merely convenient.
--
-- NOTE ON SEEDING. This migration deliberately does NOT insert anvil recipes. Two reasons,
-- both load-bearing:
--
--   1. A hardcoded list of ~620 edges would freeze the enchant catalogue at today's date.
--      PROMPTS.MD Phase 4.5 Part B is explicit that a new enchant must work with no code
--      change, and CLAUDE.md section 2 applies the same rule to tier assignment:
--      re-evaluated each run, never a migration.
--   2. Deriving them here with INSERT ... SELECT FROM products would seed nothing on a
--      fresh database, because `products` is empty until the first ingest. That would
--      reintroduce exactly the replay divergence ADR-024 just removed — production with
--      620 rows, a new environment with zero.
--
-- So anvil edges are derived from the live product list by the daily cron
-- (src/worker/rollup.ts -> syncAnvilRecipes), the same way tier assignment works. Every
-- one is written with verified = 0: tag existence is checkable, the ratio is not
-- (CLAUDE.md section 8).

ALTER TABLE recipes ADD COLUMN kind TEXT NOT NULL DEFAULT 'compact';

CREATE INDEX IF NOT EXISTS idx_recipes_kind ON recipes (kind);
