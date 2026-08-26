/**
 * Seed the LOCAL D1 with synthetic hourly rows so the band table can be developed against
 * real rows before production has accumulated 24 hours of history.
 *
 * Local only, and deliberately not TypeScript in `scripts/` next to `backfill.ts`: this is
 * a development fixture, not part of the pipeline. It writes to `--local` D1 through
 * wrangler, so it can never touch production.
 *
 * Usage: node scripts/seed-bands.mjs > /tmp/seed.sql && wrangler d1 execute bazaar --local --file /tmp/seed.sql
 */

const HOUR = 3600;
const HOURS = 24 * 30; // 30 days, so weekCount reaches its ceiling of 4

/** now, truncated to the hour. */
const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;

/**
 * A spread of shapes, chosen to exercise the states the table has to render rather than to
 * look plausible: a healthy mover, a thin expensive book, one whose bands are never both
 * touched, one that only has a few days of history, and one with thin samples.
 */
const TAGS = [
  {
    tag: "ENCHANTED_SUGAR_CANE",
    mid: 1_240_000,
    vol: 0.04,
    ibWeek: 41_000,
    isWeek: 52_000,
    hours: HOURS,
    samples: 12,
  },
  {
    tag: "ENCHANTED_COAL",
    mid: 870,
    vol: 0.05,
    ibWeek: 2_400_000,
    isWeek: 2_900_000,
    hours: HOURS,
    samples: 12,
  },
  {
    tag: "COAL",
    mid: 5.4,
    vol: 0.03,
    ibWeek: 88_000_000,
    isWeek: 91_000_000,
    hours: HOURS,
    samples: 12,
  },
  {
    tag: "ENCHANTED_ENDER_PEARL",
    mid: 2_480_000,
    vol: 0.035,
    ibWeek: 12_400,
    isWeek: 15_100,
    hours: HOURS,
    samples: 12,
  },
  {
    tag: "ENCHANTMENT_SHARPNESS_1",
    mid: 39_500,
    vol: 0.012,
    ibWeek: 900,
    isWeek: 1_100,
    hours: HOURS,
    samples: 12,
  },
  {
    tag: "ENCHANTMENT_ULTIMATE_WISE_5",
    mid: 19_800_000,
    vol: 0.02,
    ibWeek: 41,
    isWeek: 55,
    hours: HOURS,
    samples: 12,
  },
  // Under four weeks — must render its week count inline.
  {
    tag: "ENCHANTED_CACTUS_GREEN",
    mid: 148_000,
    vol: 0.045,
    ibWeek: 61_000,
    isWeek: 70_000,
    hours: 24 * 9,
    samples: 12,
  },
  // Hours assembled from a fraction of their ticks — must carry the thin-samples flag.
  {
    tag: "ENCHANTED_RAW_FISH",
    mid: 96_500,
    vol: 0.06,
    ibWeek: 22_000,
    isWeek: 26_000,
    hours: HOURS,
    samples: 3,
  },
];

/** Deterministic pseudo-random so repeated runs produce the same fixture. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

function esc(value) {
  return typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value);
}

const lines = ["DELETE FROM hourly;", "DELETE FROM products;"];

for (const spec of TAGS) {
  lines.push(
    `INSERT INTO products (tag, is_enchanted, tier, first_seen, last_seen) VALUES (${esc(spec.tag)}, 0, 'A', ${now - spec.hours * HOUR}, ${now});`,
  );

  const random = rng(spec.tag.length * 7919 + spec.mid);
  const values = [];

  for (let i = 0; i < spec.hours; i++) {
    const ts = now - (spec.hours - 1 - i) * HOUR;
    // A slow sine drift plus noise, so percentiles have something to bite on rather than
    // a flat line where p10 and p90 collapse onto the same number.
    const drift = Math.sin(i / 37) * spec.vol;
    const noise = (random() - 0.5) * spec.vol;
    const mid = spec.mid * (1 + drift + noise);
    // ask > bid always (CLAUDE.md §1) — a crossed row would be rejected by normalization,
    // which is exactly the behaviour that must not be exercised by a fixture.
    const half = mid * 0.02;
    const bidAvg = mid - half;
    const askAvg = mid + half;
    const wick = mid * 0.015;

    values.push(
      `(${esc(spec.tag)}, ${ts}, ${askAvg.toFixed(4)}, ${(askAvg - wick).toFixed(4)}, ${(askAvg + wick).toFixed(4)}, ` +
        `${bidAvg.toFixed(4)}, ${(bidAvg - wick).toFixed(4)}, ${(bidAvg + wick).toFixed(4)}, ` +
        `1000, 1000, ${spec.ibWeek}, ${spec.isWeek}, ${spec.samples}, 'hypixel')`,
    );
  }

  // Chunked so no single statement grows past what the SQLite CLI is comfortable parsing.
  for (let i = 0; i < values.length; i += 200) {
    lines.push(
      "INSERT INTO hourly (tag, hour_ts, ask_avg, ask_min, ask_max, bid_avg, bid_min, bid_max, ask_depth, bid_depth, ib_week, is_week, samples, source) VALUES\n" +
        values.slice(i, i + 200).join(",\n") +
        ";",
    );
  }
}

process.stdout.write(lines.join("\n") + "\n");
