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
  DEFAULT_HIGH_PERCENTILE,
  DEFAULT_LOW_PERCENTILE,
  DEFAULT_WINDOW_DAYS,
  HOURS_PER_WEEK,
  bandEconomics,
  computeBand,
  type BandEconomics,
  type BandError,
  type BandFlag,
  type BandHitRate,
  type BandInputs,
  type BandMarket,
  type BandThroughput,
  type BandVolume,
  type WeeklyBand,
} from "./bands.js";

export {
  ANVIL_INPUT_PER_OUTPUT,
  DEFAULT_MAX_IMPLIED_MERGE_RATIO,
  MIN_MERGE_LEVEL,
  anvilEdges,
  bookTagFor,
  booksRequired,
  deriveFamilies,
  detectMergeGates,
  levelEndpointTags,
  mergeableFamilies,
  parseBookTag,
  type AnvilOptions,
  type BookTag,
  type EnchantFamily,
  type GatedEdge,
  type MergeGateResult,
} from "./anvil.js";

export {
  cheapestPath,
  type AcquisitionPrice,
  type ConversionEdge,
  type ConversionFlag,
  type ConversionKind,
  type ConversionPlan,
  type ConversionStep,
  type ConvertError,
  type ConvertOptions,
} from "./convert.js";

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
