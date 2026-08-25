/**
 * Local-only backfill seed. ROADMAP Phase 3 (deferred — see DECISIONS.md ADR-017).
 *
 * Usage: npm run backfill -- --tag COAL --days 30
 *
 * THIS SCRIPT MUST NEVER RUN FROM THE WORKER. SkyCofl rate-limits by IP (30 req/10s and
 * 100 req/60s, enforced in parallel), and Worker subrequests come from Cloudflare's
 * shared IP pool — getting that pool blacklisted harms every other project on it, not
 * just this one. See CLAUDE.md §2.
 *
 * Rows written from here go into `hourly` with source = 'coflnet'.
 */

function usage(): never {
  console.error("usage: npm run backfill -- --tag <TAG> --days <N>");
  process.exit(1);
}

function parseArgs(argv: string[]): { tag: string; days: number } {
  let tag: string | undefined;
  let days: number | undefined;

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) usage();
    if (flag === "--tag") tag = value;
    else if (flag === "--days") days = Number(value);
    else usage();
  }

  if (!tag || !days || !Number.isFinite(days)) usage();
  return { tag, days };
}

const { tag, days } = parseArgs(process.argv.slice(2));

console.log(`backfill ${tag} over ${days}d: not implemented yet (ROADMAP Phase 3)`);
