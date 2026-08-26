/**
 * The states a table can be in that are not "here are your rows", shared by both views.
 *
 * Kept out of the band and scan folders because neither owns them: an empty table, a
 * failed refresh and a filter that removed everything look the same whichever list you
 * are looking at, and the reactions they need are the same too.
 */

/** Skeleton rows rather than a spinner: the table's shape stays put, so nothing jumps when
 *  the data lands. Matches the two-line mobile row and the one-line desktop row. */
export function TableSkeleton({ rows = 12 }: { readonly rows?: number }): React.JSX.Element {
  return (
    <div className="animate-pulse" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-2 border-b border-rule px-2 py-2 last:border-b-0 sm:py-1.5"
        >
          <div className="h-3 flex-1 rounded-sm bg-raised" />
          <div className="h-3 w-12 rounded-sm bg-raised" />
          <div className="hidden h-3 w-12 rounded-sm bg-raised sm:block" />
          <div className="hidden h-3 w-12 rounded-sm bg-raised sm:block" />
          <div className="h-3 w-10 rounded-sm bg-raised" />
        </div>
      ))}
    </div>
  );
}

/**
 * The request failed.
 *
 * The server's own sentence is shown verbatim — it names the offending parameter
 * ("'tax' must be between 0 and 0.5 ... got 1.25"), which nothing invented here could do.
 * When stale rows are still on screen the banner says so, because rows that are still true
 * but older are worth keeping and worth labelling.
 */
export function LoadError({
  error,
  stale,
}: {
  readonly error: string;
  readonly stale: boolean;
}): React.JSX.Element {
  return (
    <div className="mb-3 border border-outage/40 bg-outage/5 px-3 py-2 text-sm text-outage">
      {error}
      {stale && (
        <span className="ml-1 text-ink-dim">
          — the rows below are from the last successful load and may be out of date.
        </span>
      )}
    </div>
  );
}

/** Rows exist, but the capital filter removed all of them. A completely different problem
 *  from having no data, and the fix is one click. */
export function NothingAffordable({
  hiddenCount,
  noun,
  onClear,
}: {
  readonly hiddenCount: number;
  /** "bands" / "crafts" — plural, used in one sentence. */
  readonly noun: string;
  readonly onClear: () => void;
}): React.JSX.Element {
  return (
    <div className="border border-rule bg-surface px-4 py-6 text-sm">
      <h2 className="font-semibold text-ink">Nothing within your capital</h2>
      <p className="mt-2 text-ink-dim">
        All <span className="num">{hiddenCount}</span> {noun} need more capital than you have
        set.
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 rounded-sm border border-rule px-2 py-1 text-xs text-ink-dim hover:border-rule-strong hover:text-ink"
      >
        Clear the capital limit
      </button>
    </div>
  );
}
