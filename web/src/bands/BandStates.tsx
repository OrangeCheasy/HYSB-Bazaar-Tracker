import type { Meta } from "@core/index.js";
import { formatAge } from "../format.js";

/**
 * The states a band table can be in that are not "here are your rows".
 *
 * These matter more than usual here. For the first weeks of this site's life the honest
 * answer to "where are the bands" is "not yet" — `computeBand` needs 24 hourly rows and
 * the dataset is a rolling 30 days that started recently. An empty table with no
 * explanation cannot tell "nothing qualifies yet" from "something is broken", and those
 * demand completely different reactions from whoever is looking.
 */

/** Human-readable reasons for the `skipped` counters `runBandScan` reports. Anything
 *  unrecognised falls back to the raw key rather than being swallowed — a new reason
 *  should show up as ugly text, not as a silently missing line. */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  "insufficient-data": "not enough hourly history yet (a band needs 24 hours)",
  "no-bars": "no usable hourly rows in the window",
  "crossed-band": "the computed band came out inverted, so it was withheld",
  "invalid-percentile": "the requested percentiles were rejected",
  unnormalizable: "hourly rows exist but none passed validation",
};

function describeSkip(reason: string): string {
  return SKIP_REASONS[reason] ?? reason;
}

/**
 * No rows at all. Distinguishes "the scan ran and nothing qualified" — with the reasons —
 * from a scan that produced nothing to say.
 */
export function NoBandsYet({
  skipped,
  meta,
  now,
}: {
  readonly skipped: Readonly<Record<string, number>>;
  readonly meta: Meta | undefined;
  readonly now: number;
}): React.JSX.Element {
  const entries = Object.entries(skipped).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);

  return (
    <div className="border border-rule bg-surface px-4 py-6 text-sm">
      <h2 className="font-semibold text-ink">No bands yet</h2>
      {total > 0 ? (
        <>
          <p className="mt-2 text-ink-dim">
            The scan ran and found <span className="num">{total}</span>{" "}
            {total === 1 ? "tag" : "tags"} with hourly rows, but none could produce a band:
          </p>
          <ul className="mt-2 space-y-1 text-ink-dim">
            {entries.map(([reason, count]) => (
              <li key={reason}>
                <span className="num text-ink">{count}</span> — {describeSkip(reason)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-2 text-ink-dim">
          The scan ran but found no tags with hourly rows in the window at all. That points at
          ingestion rather than at the band maths — check the freshness indicator in the header.
        </p>
      )}
      <p className="mt-3 text-xs text-ink-faint">
        A band is computed from the trailing window of hourly rows, so a newly-collecting
        database has none until the first 24 hours are in.
        {meta !== undefined && (
          <>
            {" "}
            This answer was generated{" "}
            <span className="num">{formatAge(Math.max(0, now - meta.generatedAt))}</span> ago.
          </>
        )}
      </p>
    </div>
  );
}
