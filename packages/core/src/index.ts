export { err, ok, type Result } from "./result.js";

export {
  assignDepthToSides,
  computeDepthMetrics,
  type DepthMetrics,
  type RawOrderLevel,
} from "./depth.js";

export {
  aggregate,
  aggregateBars,
  deriveBarSides,
  deriveSides,
  isBarWellFormed,
  isWellFormed,
  normalizeCoflnetPoint,
  normalizeHourlyRow,
  normalizeMany,
  normalizeQuickStatus,
  normalizeSnapshotRow,
  pointToBar,
  type Bar,
  type DataSource,
  type NormalizeError,
  type Point,
  type RawBarSide,
  type RawCoflnetPoint,
  type RawHourlyRow,
  type RawQuickStatus,
  type RawSide,
  type RawSnapshotRow,
} from "./sides.js";

export {
  computeStats,
  mean,
  mid,
  percentile,
  sliceWindow,
  spread,
  spreadPct,
  stdev,
  type Stats,
  type StatsError,
} from "./stats.js";

export {
  bestBuyWindow,
  bestContiguousWindow,
  bestSellWindow,
  computeHourProfile,
  hourRange,
  meanOverHours,
  type Hour,
  type HourBucket,
  type HourField,
  type HourProfile,
  type HourWindow,
  type ProfileError,
} from "./profile.js";

export {
  analyzeCraft,
  applySellTax,
  computeThroughput,
  detectFlags,
  type CraftAnalysis,
  type CraftInputs,
  type EconomicsError,
  type MarketConfig,
  type ScenarioKind,
  type ScenarioResult,
  type Throughput,
  type WarningFlag,
} from "./economics.js";

export {
  DEFAULT_RATIO,
  RATIO_EXCEPTIONS,
  expectedRatio,
  isEnchantedTag,
  parityPrice,
  validateRecipe,
  type Recipe,
  type RecipeIssue,
} from "./recipes.js";
