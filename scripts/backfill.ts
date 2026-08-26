/**
 * Local-only historical backfill. ROADMAP Phase 3.
 *
 * Usage: npm run backfill -- --days 30 --dry-run
 *        npm run backfill -- --days 30 --remote
 *        npm run backfill -- --tag COAL --days 7 --remote
 *
 * THIS SCRIPT MUST NEVER RUN FROM THE WORKER. SkyCofl rate-limits by IP (30 req/10s and
 * 100 req/60s, enforced in parallel), and Worker subrequests come from Cloudflare's
 * shared IP pool — getting that pool blacklisted harms every other project on it, not
 * just this one. See CLAUDE.md section 2. The boundary is enforced by an ESLint rule in
 * eslint.config.mjs, because a comment is not enforcement.
 *
 * It does two jobs, and the second is the one that keeps mattering after today:
 *
 *   1. SEED — fill `hourly` back to the 30-day retention edge so the trailing weekly
 *      band and the hour-of-day profile work now instead of in a month. Rows land with
 *      source = 'coflnet' so they stay distinguishable from our own five-minute data.
 *   2. AUDIT — cross-reference Coflnet's coverage against ours and report every hour
 *      where they have a bar and we have no `source='hypixel'` row. That is a direct
 *      readout of holes in our own collection (CLAUDE.md section 3b), and unlike the
 *      seed it is worth re-running any time the cron looks suspicious.
 *
 * Nothing here writes a row that already exists: every INSERT is ON CONFLICT DO NOTHING,
 * so a re-run is a no-op rather than a duplicate, and our own richer 12-sample rows are
 * never overwritten by a coarser third-party bar.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeCoflnetPoint, type Bar, type RawCoflnetPoint } from "@hysb/core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const HOUR = 3600;
const DAY = 24 * HOUR;

/**
 * The retention cap, and therefore the ceiling on anything worth fetching. Asking for
 * day 31 spends someone else's rate limit on rows the next 04:23 prune deletes
 * (CLAUDE.md section 3, ADR-021).
 */
const MAX_DAYS = 30;

/**
 * Coflnet picks its bucket size from the SPAN YOU ASK FOR, not from how old the data is.
 * Measured against COAL on 2026-08-26, one request per row:
 *
 *   requested span   points   spacing
 *   1 day               12    2h
 *   4 days              48    2h        (one 4h hole — their data, not ours)
 *   7 days              84    2h
 *   8 days               8    ~24h
 *   30 days             30    ~24h
 *
 * The cliff is exactly at 7 days, and a 1-day window 29 days back still returns 2h
 * buckets — so age costs nothing and span costs everything. Requesting the 30 days in
 * one call would return 30 daily points and make the hour-of-day profile, the only
 * thing this data is for, impossible to compute. Hence five chunked requests per tag.
 */
const CHUNK_DAYS = 7;

/**
 * SkyCofl enforces 30 req/10s and 100 req/60s IN PARALLEL. 1.05s between request starts
 * is 9.5 per 10s and 57 per minute — comfortably inside both, with the headroom going to
 * not being the reason the shared Cloudflare egress pool gets blacklisted.
 */
const MIN_REQUEST_INTERVAL_MS = 1050;

/** A 429 without a usable Retry-After. Long enough to actually clear a rolling window. */
const DEFAULT_BACKOFF_MS = 15_000;

const MAX_ATTEMPTS = 4;

/**
 * How many hourly rows one Coflnet bucket may paint, at most.
 *
 * Coflnet's buckets are wider than an hour, so a bucket has to cover the hours inside it
 * or half of `hourly` stays empty and the band's percentiles run on half their input.
 * Painting is bounded by the bucket's OWN width, never by the distance to the next
 * bucket: when Coflnet itself has a hole, the hours in that hole must stay empty and get
 * reported as missing rather than back-filled from a reading taken hours away. This is
 * the ceiling on that width, so a freak 24h gap cannot invent a day of prices.
 */
const MAX_FILL_HOURS = 6;

const COFLNET_BASE = "https://sky.coflnet.com/api/bazaar";

/** Flush buffered rows to D1 at roughly this many, on a tag boundary. */
const FLUSH_ROW_THRESHOLD = 10_000;

/**
 * ...and at this many tags regardless, because progress is only durable once a flush has
 * happened. On the row threshold alone a 30-tag run never flushes until the very end, so
 * an interrupt three minutes in resumed from nothing. A flush costs one wrangler spawn
 * (~2s), so this bounds what an interrupt can cost to roughly two minutes of fetching.
 */
const FLUSH_TAG_THRESHOLD = 25;

const STATE_PATH = join(import.meta.dirname, ".backfill-state.json");

/** A resumed run older than this is stale — its window has moved. Start fresh instead. */
const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const WRANGLER = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  readonly tag: string | undefined;
  readonly days: number;
  readonly dryRun: boolean;
  readonly remote: boolean;
  readonly recipesOnly: boolean;
  readonly fresh: boolean;
  readonly auditOnly: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`\nerror: ${message}`);
  console.error(`
usage: npm run backfill -- [options]

  --days <N>      how far back to fetch, in days. default 30, maximum ${MAX_DAYS}.
  --tag <TAG>     one tag only. default: every Tier A tag in the target database.
  --recipes-only  narrow the default set to tags referenced by a recipe.
  --remote        write to the PRODUCTION D1. default is --local.
  --local         write to the local D1 under .wrangler/state (the default).
  --dry-run       report what would be fetched, and how long it would take. Writes nothing.
  --audit-only    fetch and report coverage gaps, but write no rows.
  --fresh         discard any saved progress and start over.
  --help          this.
`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv: readonly string[]): Options {
  let tag: string | undefined;
  let days = MAX_DAYS;
  let dryRun = false;
  let remote = false;
  let recipesOnly = false;
  let fresh = false;
  let auditOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") usage();
    switch (flag) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--audit-only":
        auditOnly = true;
        break;
      case "--remote":
        remote = true;
        break;
      case "--local":
        remote = false;
        break;
      case "--recipes-only":
        recipesOnly = true;
        break;
      case "--fresh":
        fresh = true;
        break;
      case "--tag": {
        const value = argv[++i];
        if (value === undefined) usage("--tag needs a value");
        if (!/^[A-Z0-9_:.\-;]+$/.test(value)) usage(`--tag ${value} is not a bazaar tag`);
        tag = value;
        break;
      }
      case "--days": {
        const value = argv[++i];
        if (value === undefined) usage("--days needs a value");
        days = Number(value);
        break;
      }
      default:
        usage(`unrecognised flag ${flag ?? ""}`);
    }
  }

  if (!Number.isInteger(days) || days < 1) usage("--days must be a positive whole number");
  if (days > MAX_DAYS) {
    usage(
      `--days ${days} exceeds the ${MAX_DAYS}-day cap.\n` +
        `       Nothing in this system is kept longer than 30 days (CLAUDE.md section 3), so\n` +
        `       the 04:23 prune would delete anything older on its next run. Fetching it\n` +
        `       spends SkyCofl's rate limit on rows we throw away tonight.`,
    );
  }

  return { tag, days, dryRun, remote, recipesOnly, fresh, auditOnly };
}

// ---------------------------------------------------------------------------
// D1 — via the wrangler CLI, so this uses the same auth and the same database
// name as everything else rather than a second set of credentials.
// ---------------------------------------------------------------------------

/**
 * `--local` and `--remote` are entirely separate databases (CLAUDE.md section 3). The
 * target is threaded through every call rather than read from a module global, so a
 * read and its matching write cannot end up pointed at different databases.
 */
type Target = "--local" | "--remote";

interface D1Result<T> {
  readonly results: readonly T[];
  readonly success: boolean;
}

/** wrangler prints a banner before its JSON. Find the payload rather than trusting line 1. */
function extractJson(stdout: string): string {
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error(`no JSON in wrangler output:\n${stdout.slice(0, 500)}`);
  return stdout.slice(start);
}

/**
 * No `WRANGLER_LOG` override here, deliberately. Wrangler emits its `--json` payload
 * through the same logger as its banner, so quieting the logger to `error` returns an
 * empty stdout and every query silently comes back with no rows. `extractJson` skips the
 * banner instead.
 */
async function runWrangler(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [WRANGLER, ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

async function d1Query<T>(target: Target, sql: string): Promise<readonly T[]> {
  const stdout = await runWrangler([
    "d1",
    "execute",
    "bazaar",
    target,
    "--json",
    "--command",
    sql,
  ]);
  const parsed = JSON.parse(extractJson(stdout)) as readonly D1Result<T>[];
  return parsed.flatMap((r) => r.results ?? []);
}

/**
 * Statements go through a temp .sql file rather than --command. A flush is tens of
 * thousands of INSERTs and megabytes of SQL, which is past what a command line will
 * carry on Windows.
 */
async function d1Execute(target: Target, statements: readonly string[]): Promise<void> {
  if (statements.length === 0) return;
  const dir = mkdtempSync(join(tmpdir(), "hysb-backfill-"));
  const file = join(dir, "batch.sql");
  try {
    writeFileSync(file, statements.join("\n"), "utf8");
    await runWrangler(["d1", "execute", "bazaar", target, "--yes", "--file", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`refusing to write a non-finite number`);
  return String(value);
}

// ---------------------------------------------------------------------------
// TAG SELECTION
// ---------------------------------------------------------------------------

async function selectTags(target: Target, opts: Options): Promise<readonly string[]> {
  if (opts.tag) return [opts.tag];

  // Tier A is the ROADMAP's Definition of Done for this phase, and it is a superset of
  // the recipe tags — recipe membership is one of the three clauses that puts a tag in
  // it (CLAUDE.md section 2). Tier is recomputed every ingest, so this list is current
  // by construction and never needs a migration to change.
  const sql = opts.recipesOnly
    ? `SELECT base_tag AS tag FROM recipes UNION SELECT ench_tag AS tag FROM recipes ORDER BY tag`
    : `SELECT tag FROM products WHERE tier = 'A' ORDER BY tag`;

  const rows = await d1Query<{ tag: string }>(target, sql);
  return rows.map((r) => r.tag).filter((t) => typeof t === "string" && t.length > 0);
}

// ---------------------------------------------------------------------------
// OUR OWN COVERAGE — read before writing anything, and filtered to source='hypixel'
// ---------------------------------------------------------------------------

interface Coverage {
  /** Hours we hold from our own ingest. Coflnet rows are deliberately excluded. */
  readonly hours: ReadonlySet<number>;
  /** Our earliest own row. Hours before this are "not yet collecting", not gaps. */
  readonly firstHour: number | undefined;
}

/**
 * A previous backfill's own rows must not count as coverage, or the second run reports
 * a clean bill of health for exactly the hours the first run papered over. Gaps are
 * defined against `source='hypixel'` only.
 */
async function loadCoverage(
  target: Target,
  tags: readonly string[],
  since: number,
): Promise<Map<string, Coverage>> {
  const coverage = new Map<string, Coverage>();
  const BATCH = 100;

  for (let i = 0; i < tags.length; i += BATCH) {
    const batch = tags.slice(i, i + BATCH);
    const list = batch.map(sqlString).join(",");
    const rows = await d1Query<{ tag: string; hours: string | null }>(
      target,
      `SELECT tag, group_concat(hour_ts) AS hours FROM hourly
       WHERE source = 'hypixel' AND hour_ts >= ${sqlNumber(since)} AND tag IN (${list})
       GROUP BY tag`,
    );
    for (const row of rows) {
      const hours = new Set(
        (row.hours ?? "")
          .split(",")
          .filter((s) => s.length > 0)
          .map(Number),
      );
      let firstHour: number | undefined;
      for (const h of hours) if (firstHour === undefined || h < firstHour) firstHour = h;
      coverage.set(row.tag, { hours, firstHour });
    }
  }

  for (const tag of tags) {
    if (!coverage.has(tag)) coverage.set(tag, { hours: new Set(), firstHour: undefined });
  }
  return coverage;
}

// ---------------------------------------------------------------------------
// COFLNET CLIENT
// ---------------------------------------------------------------------------

/**
 * Paces by request START time, so a slow response does not add to the next wait and the
 * printed ETA stays honest. Sequential by construction — there is no concurrency here
 * and there must not be.
 */
class RateLimiter {
  private nextAllowedAt = 0;

  async wait(): Promise<void> {
    const delay = this.nextAllowedAt - Date.now();
    if (delay > 0) await sleep(delay);
    this.nextAllowedAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  }

  /** A 429 pushes the whole schedule out, not just the retry. */
  penalise(ms: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + ms);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `Retry-After` is either seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_BACKOFF_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 120_000);
  return DEFAULT_BACKOFF_MS;
}

async function fetchChunk(
  limiter: RateLimiter,
  tag: string,
  from: number,
  to: number,
): Promise<readonly RawCoflnetPoint[]> {
  const url =
    `${COFLNET_BASE}/${encodeURIComponent(tag)}/history` +
    `?start=${encodeURIComponent(isoUtc(from))}&end=${encodeURIComponent(isoUtc(to))}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await limiter.wait();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "HYSB-BazzarTracker/backfill" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (cause) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`${tag}: network error`, { cause });
      limiter.penalise(2000 * attempt);
      continue;
    }

    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get("retry-after"));
      process.stderr.write(`\n  429 on ${tag} — backing off ${Math.round(wait / 1000)}s\n`);
      limiter.penalise(wait);
      continue;
    }

    if (response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`${tag}: upstream ${response.status}`);
      limiter.penalise(2000 * attempt);
      continue;
    }

    if (!response.ok) throw new Error(`${tag}: HTTP ${response.status}`);

    const body: unknown = await response.json();
    // An unknown tag and a tag with no history are both `[]` with a 200. We cannot tell
    // them apart, so neither is an error — both are reported as "no upstream data".
    if (!Array.isArray(body)) throw new Error(`${tag}: expected an array`);
    return body as readonly RawCoflnetPoint[];
  }

  throw new Error(`${tag}: gave up after ${MAX_ATTEMPTS} attempts`);
}

// ---------------------------------------------------------------------------
// BUCKETS → HOURLY ROWS
// ---------------------------------------------------------------------------

function floorHour(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

/**
 * The bucket width Coflnet actually used, in hours — measured, not assumed.
 *
 * Coflnet coarsens with the requested span and drops buckets outright when it has no
 * data, so spacing is neither constant across runs nor even within one response. The
 * median of the observed gaps is robust against those holes in a way that the mean and
 * the first-difference are not.
 */
function observedResolutionHours(sortedTs: readonly number[]): number {
  if (sortedTs.length < 2) return 1;
  const gaps: number[] = [];
  for (let i = 1; i < sortedTs.length; i++) {
    const gap = Math.round((sortedTs[i]! - sortedTs[i - 1]!) / HOUR);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 1;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  return Math.min(Math.max(median, 1), MAX_FILL_HOURS);
}

interface HourlyRow {
  readonly tag: string;
  readonly hourTs: number;
  readonly bar: Bar;
}

interface TagSeries {
  readonly rows: readonly HourlyRow[];
  /** Every hour Coflnet actually covers. The denominator for the gap audit. */
  readonly covered: ReadonlySet<number>;
  readonly bucketCount: number;
  readonly rejected: number;
  readonly resolutionHours: number;
}

/**
 * Expand Coflnet's buckets into the hourly rows they cover.
 *
 * A bucket paints its own width and no more. Where Coflnet has a hole, the hole stays a
 * hole — it is reported by the audit rather than filled in from a reading taken hours
 * away. Each row keeps `samples = 1` and `source = 'coflnet'`, which is the honest
 * statement that this hour rests on one coarse third-party observation rather than the
 * twelve of our own (CLAUDE.md section 3b).
 */
function buildSeries(
  tag: string,
  points: readonly RawCoflnetPoint[],
  windowEnd: number,
): TagSeries {
  const bars: Bar[] = [];
  let rejected = 0;

  for (const point of points) {
    const result = normalizeCoflnetPoint(point, HOUR);
    if (result.ok) bars.push(result.value);
    else rejected++;
  }

  bars.sort((a, b) => a.ts - b.ts);
  const resolutionHours = observedResolutionHours(bars.map((b) => b.ts));

  const rows: HourlyRow[] = [];
  const covered = new Set<number>();
  const seen = new Set<number>();

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    const start = floorHour(bar.ts);
    const next = bars[i + 1];
    // Bounded by the bucket's own width AND by where the next bucket starts, so two
    // buckets can never both claim the same hour.
    const span = next
      ? Math.min(resolutionHours, Math.max(1, Math.round((floorHour(next.ts) - start) / HOUR)))
      : resolutionHours;

    for (let h = 0; h < span; h++) {
      const hourTs = start + h * HOUR;
      // The current hour is still being written by our own ingest, and hours past the
      // window are not ours to touch.
      if (hourTs >= windowEnd) break;
      if (seen.has(hourTs)) continue;
      seen.add(hourTs);
      covered.add(hourTs);
      rows.push({ tag, hourTs, bar });
    }
  }

  return { rows, covered, bucketCount: bars.length, rejected, resolutionHours };
}

/**
 * ON CONFLICT DO NOTHING is the whole idempotency story, and it points the right way:
 * a re-run writes nothing, and a coarse Coflnet bar can never overwrite one of our own
 * twelve-sample rows. `last_tick_ts` keeps its default of 0 — it is the guard for Tier
 * B's live direct-write path (migration 0002) and means nothing for a historical row.
 */
function insertStatement(rows: readonly HourlyRow[]): string {
  const values = rows.map(({ tag, hourTs, bar }) =>
    [
      sqlString(tag),
      sqlNumber(hourTs),
      sqlNumber(bar.askAvg),
      sqlNumber(bar.askMin),
      sqlNumber(bar.askMax),
      sqlNumber(bar.bidAvg),
      sqlNumber(bar.bidMin),
      sqlNumber(bar.bidMax),
      sqlNumber(bar.askDepth),
      sqlNumber(bar.bidDepth),
      sqlNumber(bar.ibWeek),
      sqlNumber(bar.isWeek),
      "1",
      "'coflnet'",
    ].join(","),
  );

  return (
    `INSERT INTO hourly (tag,hour_ts,ask_avg,ask_min,ask_max,bid_avg,bid_min,bid_max,` +
    `ask_depth,bid_depth,ib_week,is_week,samples,source) VALUES ` +
    values.map((v) => `(${v})`).join(",") +
    ` ON CONFLICT(tag,hour_ts) DO NOTHING;`
  );
}

// ---------------------------------------------------------------------------
// RESUME STATE
// ---------------------------------------------------------------------------

interface TagReport {
  readonly buckets: number;
  readonly rowsOffered: number;
  readonly rejected: number;
  readonly resolutionHours: number;
  /** Hours Coflnet has, we do not, and we were already collecting. Real holes. */
  readonly gapHours: readonly number[];
  /** Hours Coflnet has from before our first own row. Expected, and now seeded. */
  readonly seededHours: number;
}

interface State {
  readonly version: 1;
  readonly target: Target;
  readonly days: number;
  readonly selection: string;
  readonly startedAt: number;
  readonly done: Record<string, TagReport>;
}

function loadState(opts: Options, target: Target, selection: string): State {
  const fresh: State = {
    version: 1,
    target,
    days: opts.days,
    selection,
    startedAt: Date.now(),
    done: {},
  };
  if (opts.fresh || !existsSync(STATE_PATH)) return fresh;

  try {
    const saved = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
    const compatible =
      saved.version === 1 &&
      saved.target === target &&
      saved.days === opts.days &&
      saved.selection === selection;

    if (!compatible) {
      console.log("saved progress does not match these arguments — starting a fresh run");
      return fresh;
    }
    // The window is anchored to "now", so resuming yesterday's run would fetch a range
    // that no longer matches the rows already written.
    if (Date.now() - saved.startedAt > STATE_MAX_AGE_MS) {
      console.log("saved progress is over a day old — its window has moved, starting fresh");
      return fresh;
    }
    const count = Object.keys(saved.done).length;
    if (count > 0) console.log(`resuming: ${count} tags already complete (--fresh to discard)`);
    return saved;
  } catch {
    console.log("saved progress is unreadable — starting a fresh run");
    return fresh;
  }
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// REPORTING
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function summarise(hours: readonly number[], limit = 6): string {
  const shown = hours.slice(0, limit).map((h) => isoUtc(h).replace(":00:00Z", "h"));
  return hours.length > limit
    ? `${shown.join(" ")} +${hours.length - limit} more`
    : shown.join(" ");
}

function reportGaps(done: Record<string, TagReport>): void {
  const entries = Object.entries(done);
  const withGaps = entries
    .filter(([, r]) => r.gapHours.length > 0)
    .sort((a, b) => b[1].gapHours.length - a[1].gapHours.length);

  const empty = entries.filter(([, r]) => r.buckets === 0).map(([tag]) => tag);
  const seeded = entries.reduce((n, [, r]) => n + r.seededHours, 0);
  const gapTotal = withGaps.reduce((n, [, r]) => n + r.gapHours.length, 0);

  console.log(`\n${"=".repeat(72)}`);
  console.log("COVERAGE AUDIT — hours Coflnet has and our own ingest does not");
  console.log("=".repeat(72));
  console.log(
    `\nHours seeded from before our collection started: ${seeded.toLocaleString()}\n` +
      `  Expected, not a fault — there is nothing to compare against before our first row.\n`,
  );

  if (withGaps.length === 0) {
    console.log("No gaps. Every hour Coflnet covers since our first row, we also cover.\n");
  } else {
    console.log(
      `GAPS in our own collection: ${gapTotal.toLocaleString()} hours across ${withGaps.length} tags.\n` +
        `  These are hours we were already running and still have no row for. A gap older\n` +
        `  than 30 days is unrecoverable (CLAUDE.md section 3b) — check \`runs\` for the\n` +
        `  matching window before assuming it is only a display problem.\n`,
    );
    for (const [tag, r] of withGaps.slice(0, 25)) {
      console.log(
        `  ${tag.padEnd(34)} ${String(r.gapHours.length).padStart(4)}  ${summarise(r.gapHours)}`,
      );
    }
    if (withGaps.length > 25) console.log(`  ... and ${withGaps.length - 25} more tags`);
    console.log("");
  }

  if (empty.length > 0) {
    console.log(
      `No upstream data for ${empty.length} tags (unknown to Coflnet, or never traded):\n` +
        `  ${empty.slice(0, 12).join(", ")}${empty.length > 12 ? `, +${empty.length - 12} more` : ""}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const target: Target = opts.remote ? "--remote" : "--local";

  const windowEnd = floorHour(Date.now() / 1000);
  const windowStart = windowEnd - opts.days * DAY;
  const chunksPerTag = Math.ceil(opts.days / CHUNK_DAYS);

  console.log(`\nbackfill — SkyCofl → D1 hourly (source='coflnet')`);
  console.log(`  database   bazaar ${target.slice(2)}`);
  console.log(`  window     ${isoUtc(windowStart)} .. ${isoUtc(windowEnd)}  (${opts.days}d)`);

  const selection = opts.tag ?? (opts.recipesOnly ? "recipes" : "tierA");
  const tags = await selectTags(target, opts);
  if (tags.length === 0) {
    console.error(
      `\nno tags selected. The ${target.slice(2)} database has no Tier A products —` +
        ` run an ingest first, or pass --tag.`,
    );
    process.exit(1);
  }

  const state = loadState(opts, target, selection);
  const pending = tags.filter((t) => !(t in state.done));
  const requests = pending.length * chunksPerTag;
  const eta = requests * MIN_REQUEST_INTERVAL_MS;

  console.log(
    `  tags       ${tags.length} (${selection})${pending.length !== tags.length ? `, ${pending.length} still to do` : ""}`,
  );
  console.log(
    `  requests   ${requests} — ${chunksPerTag} chunks of ${CHUNK_DAYS}d per tag, so Coflnet returns` +
      ` 2h buckets\n             rather than the daily ones a single 30d call would give`,
  );
  console.log(
    `  pacing     ${MIN_REQUEST_INTERVAL_MS}ms between requests (SkyCofl: 30/10s and 100/60s)`,
  );
  console.log(`  ETA        ~${formatDuration(eta)}\n`);

  if (opts.dryRun) {
    console.log(`dry run — nothing fetched, nothing written.`);
    console.log(
      `  would write up to ~${(pending.length * opts.days * 24).toLocaleString()} hourly rows,`,
    );
    console.log(
      `  every one of them ON CONFLICT DO NOTHING, so existing rows are untouched.\n`,
    );
    return;
  }

  console.log(`reading our own coverage (source='hypixel') for ${tags.length} tags...`);
  const coverage = await loadCoverage(target, tags, windowStart);

  const limiter = new RateLimiter();
  const startedAt = Date.now();
  let buffer: HourlyRow[] = [];
  let written = 0;
  let processed = 0;
  let tagsSinceFlush = 0;

  // Ctrl+C finishes the tag in hand, flushes, and saves, so the next run picks up where
  // this one stopped instead of starting over. A second signal gives up immediately —
  // and even then nothing is lost that a re-fetch cannot redo, because every insert is
  // ON CONFLICT DO NOTHING.
  let interrupted = false;
  const onSignal = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write("\n\ninterrupted — finishing this tag, then saving progress...\n");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const flushAndSave = async (): Promise<void> => {
    if (buffer.length > 0 && !opts.auditOnly) {
      const statements: string[] = [];
      // Chunked so no single INSERT grows past what SQLite will parse comfortably.
      for (let i = 0; i < buffer.length; i += 100) {
        statements.push(insertStatement(buffer.slice(i, i + 100)));
      }
      await d1Execute(target, statements);
      written += buffer.length;
    }
    buffer = [];
    tagsSinceFlush = 0;
    // Only now is the progress durable: the rows these tags produced are in D1, so a
    // resume may safely skip them.
    saveState(state);
  };

  for (const tag of pending) {
    if (interrupted) break;
    const points: RawCoflnetPoint[] = [];
    for (let i = 0; i < chunksPerTag; i++) {
      const from = windowStart + i * CHUNK_DAYS * DAY;
      const to = Math.min(from + CHUNK_DAYS * DAY, windowEnd);
      if (from >= to) break;
      points.push(...(await fetchChunk(limiter, tag, from, to)));
    }

    const series = buildSeries(tag, points, windowEnd);
    const own = coverage.get(tag) ?? { hours: new Set<number>(), firstHour: undefined };

    const gapHours: number[] = [];
    let seededHours = 0;
    for (const hour of [...series.covered].sort((a, b) => a - b)) {
      if (own.hours.has(hour)) continue;
      // Before our first own row we were simply not collecting yet. That is the seed
      // job doing its job, not a hole in the cron.
      if (own.firstHour === undefined || hour < own.firstHour) seededHours++;
      else gapHours.push(hour);
    }

    buffer.push(...series.rows);
    processed++;
    tagsSinceFlush++;
    state.done[tag] = {
      buckets: series.bucketCount,
      rowsOffered: series.rows.length,
      rejected: series.rejected,
      resolutionHours: series.resolutionHours,
      gapHours,
      seededHours,
    };

    const elapsed = Date.now() - startedAt;
    const remaining = ((pending.length - processed) * elapsed) / processed;
    process.stdout.write(
      `\r  [${processed}/${pending.length}] ${tag.padEnd(32).slice(0, 32)} ` +
        `${String(series.rows.length).padStart(4)} rows  ` +
        `${series.resolutionHours}h buckets  ` +
        `${gapHours.length > 0 ? `${gapHours.length} gaps  ` : ""}` +
        `~${formatDuration(remaining)} left      `,
    );

    if (buffer.length >= FLUSH_ROW_THRESHOLD || tagsSinceFlush >= FLUSH_TAG_THRESHOLD) {
      process.stdout.write("\n");
      await flushAndSave();
    }
  }

  await flushAndSave();
  process.stdout.write("\n");

  const rejected = Object.values(state.done).reduce((n, r) => n + r.rejected, 0);
  console.log(
    `\ndone in ${formatDuration(Date.now() - startedAt)} — ` +
      `${written.toLocaleString()} rows offered to ${target.slice(2)} D1` +
      `${opts.auditOnly ? " (audit-only: nothing written)" : ""}` +
      `${rejected > 0 ? `, ${rejected} malformed buckets rejected` : ""}`,
  );
  if (!opts.auditOnly) {
    console.log(
      `  "offered" not "inserted": rows whose hour we already hold were dropped by\n` +
        `  ON CONFLICT DO NOTHING, which is what makes a re-run a no-op.`,
    );
  }

  reportGaps(state.done);
}

main().catch((error: unknown) => {
  process.stderr.write("\n");
  console.error(error instanceof Error ? `backfill failed: ${error.message}` : error);
  if (error instanceof Error && error.cause) console.error(error.cause);
  process.exit(1);
});
