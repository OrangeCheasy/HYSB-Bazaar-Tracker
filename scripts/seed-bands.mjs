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
 * Base materials, priced roughly where the live bazaar has them.
 *
 * The enchanted forms are DERIVED from these (see below) rather than given fixed prices.
 * An earlier version of this fixture set them independently and landed them at almost
 * exactly 160x parity, which made every compaction craft break even — so the local scan
 * showed COAL to ENCHANTED_COAL at -12.9% while production showed +45%, and the fixture
 * looked exactly like a bug in the economics. Measured multiples over parity on the live
 * market: coal 1.76x, sugar cane 1.97x, diamond 1.41x, ender pearl 8.62x. Nothing trades
 * at parity, because Super Compactor supply sets a floor rather than a fair value.
 */
const BASES = [
  {
    tag: "COAL",
    mid: 5.8,
    ratio: 160,
    multiple: 1.76,
    vol: 0.03,
    ibWeek: 88_000_000,
    isWeek: 91_000_000,
  },
  {
    tag: "SUGAR_CANE",
    mid: 2.14,
    ratio: 160,
    multiple: 1.97,
    vol: 0.04,
    ibWeek: 60_000_000,
    isWeek: 64_000_000,
  },
  {
    tag: "DIAMOND",
    mid: 5.93,
    ratio: 160,
    multiple: 1.41,
    vol: 0.035,
    ibWeek: 12_000_000,
    isWeek: 13_500_000,
  },
  {
    tag: "ENDER_PEARL",
    mid: 1.2,
    ratio: 20,
    multiple: 8.62,
    vol: 0.05,
    ibWeek: 9_000_000,
    isWeek: 9_800_000,
  },
  // Thin samples: hours built from a fraction of their ticks, so it carries that flag.
  {
    tag: "RAW_FISH",
    mid: 12.4,
    ratio: 160,
    multiple: 1.5,
    vol: 0.06,
    ibWeek: 900_000,
    isWeek: 1_100_000,
    samples: 3,
  },
  // Under four weeks of history, so its band reports a short window.
  {
    tag: "CACTUS",
    mid: 3.1,
    ratio: 160,
    multiple: 1.6,
    vol: 0.045,
    ibWeek: 40_000_000,
    isWeek: 44_000_000,
    hours: 24 * 9,
  },
];

const TAGS = [];
for (const base of BASES) {
  const hours = base.hours ?? HOURS;
  const samples = base.samples ?? 12;
  TAGS.push({
    tag: base.tag,
    mid: base.mid,
    vol: base.vol,
    ibWeek: base.ibWeek,
    isWeek: base.isWeek,
    hours,
    samples,
  });
  TAGS.push({
    tag: `ENCHANTED_${base.tag}`,
    // The whole point: priced off the base, at the multiple the real market shows.
    mid: base.mid * base.ratio * base.multiple,
    vol: base.vol * 0.7,
    // An enchanted form trades in far fewer units than its base, by roughly the ratio.
    ibWeek: Math.max(1, Math.round(base.ibWeek / base.ratio / 3)),
    isWeek: Math.max(1, Math.round(base.isWeek / base.ratio / 3)),
    hours,
    samples,
  });
}

/**
 * Enchant families, as full level chains.
 *
 * Anvil recipes are derived at RUNTIME by the daily cron from the live product list, so a
 * local database that has never run that cron has zero anvil rows and the scan's craft-type
 * column has nothing to show. This writes both the book rungs and the 2:1 merge edges
 * between them, the same shape `anvilEdges` produces.
 *
 * Prices climb slightly faster than 2x per level so merging is a small loss on some rungs
 * and a small gain on others — which is what the real market looks like, and what makes the
 * cheapest-entry search do any work.
 */
const FAMILIES = [
  {
    family: "ENCHANTMENT_SHARPNESS",
    levels: 7,
    base: 38_000,
    step: 1.95,
    ibWeek: 900,
    isWeek: 1_100,
  },
  {
    family: "ENCHANTMENT_GROWTH",
    levels: 6,
    base: 120_000,
    step: 2.05,
    ibWeek: 400,
    isWeek: 520,
  },
  {
    family: "ENCHANTMENT_ULTIMATE_WISE",
    levels: 5,
    base: 1_250_000,
    step: 2.4,
    ibWeek: 41,
    isWeek: 55,
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

const lines = [
  "DELETE FROM hourly;",
  "DELETE FROM products;",
  // Only the derived anvil edges — the compaction recipes come from migration 0003 and
  // deleting them would leave a local database that no migration can restore.
  "DELETE FROM recipes WHERE kind = 'anvil';",
];

/** Every book rung, expanded into the same shape a real tag has. */
for (const fam of FAMILIES) {
  for (let level = 1; level <= fam.levels; level++) {
    TAGS.push({
      tag: `${fam.family}_${level}`,
      mid: fam.base * Math.pow(fam.step, level - 1),
      vol: 0.03,
      // Thinner at every rung up, which is what makes the top rungs 21% of coin turnover
      // on 4.6% of units (CLAUDE.md §2).
      ibWeek: Math.max(1, Math.round(fam.ibWeek / Math.pow(2, level - 1))),
      isWeek: Math.max(1, Math.round(fam.isWeek / Math.pow(2, level - 1))),
      hours: HOURS,
      samples: 12,
    });
  }

  // The merge edges themselves: two books of level N make one of level N+1.
  for (let level = 1; level < fam.levels; level++) {
    lines.push(
      `INSERT INTO recipes (base_tag, ench_tag, ratio, verified, note, kind) VALUES ` +
        `(${esc(`${fam.family}_${level}`)}, ${esc(`${fam.family}_${level + 1}`)}, 2, 0, ` +
        `'seeded fixture', 'anvil');`,
    );
  }
}

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
