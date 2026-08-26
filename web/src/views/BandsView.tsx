import { useMemo, useState } from "react";
import { fetchBands } from "../api/endpoints.js";
import { useApi } from "../api/useApi.js";
import { BandTable } from "../bands/BandTable.js";
import { NoBandsYet } from "../bands/BandStates.js";
import { LoadError, NothingAffordable, TableSkeleton } from "../ui/TableStates.js";
import { splitByCapital } from "../bands/capital.js";
import { DEFAULT_SORT, sortByKey, sortRows, type Sort, type SortKey } from "../bands/sort.js";
import { formatAge, formatCoins } from "../format.js";
import { queryString, toBandQuery } from "../settings/toQuery.js";
import { useNow } from "../useNow.js";
import { updateSettings, useSettings } from "../settings/store.js";

/**
 * The landing view: where to rest a buy order and a sell offer tonight.
 *
 * Optimised for scanning a lot of rows rather than for explaining one — the explaining
 * happens on the detail page. So: no row expansion, no per-row prose, one line per tag on
 * a desktop, and every figure that the non-negotiables require sits in the row itself.
 */

/** Rendered rows before "show all". A few hundred rows of nine cells each is enough DOM to
 *  hurt on a phone, and nobody scans past the first hundred anyway — but the cap is a
 *  render limit only. Sorting and filtering always run over the whole set, so raising the
 *  cap never changes what is at the top. */
const INITIAL_RENDER_LIMIT = 150;

const SORT_OPTIONS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: "profitPerDay", label: "Profit / day" },
  { key: "spreadPct", label: "Spread" },
  { key: "bothHitWeeks", label: "Weeks both filled" },
  { key: "buyHitRate", label: "Buy fill rate" },
  { key: "sellHitRate", label: "Sell fill rate" },
  { key: "capitalPerDay", label: "Capital / day" },
  { key: "tag", label: "Tag" },
];

export function BandsView(): React.JSX.Element {
  const settings = useSettings();
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [showAll, setShowAll] = useState(false);

  // The query string is the request's identity, so it is also the cache key: changing a
  // band percentile in the drawer refetches, changing the tax rate does not (tax is not a
  // band parameter and would only have invalidated the request for nothing).
  const path = `/api/bands${queryString(toBandQuery(settings))}`;
  const { data, meta, error, loading } = useApi(path, (signal) => fetchBands(settings, signal));

  const rows = data?.rows;
  const skipped = data?.skipped ?? {};

  const { affordable, hiddenCount } = useMemo(
    () => splitByCapital(rows ?? [], settings.capital),
    [rows, settings.capital],
  );
  const sorted = useMemo(() => sortRows(affordable, sort), [affordable, sort]);
  const visible = showAll ? sorted : sorted.slice(0, INITIAL_RENDER_LIMIT);

  const now = useNow();
  const staleFor = meta !== undefined ? Math.max(0, now - meta.generatedAt) : undefined;

  return (
    <section>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-semibold tracking-tight text-ink">Weekly bands</h1>
        <p className="text-xs text-ink-dim">
          Buy at the trailing low, sell at the trailing high. Both figures are conditional on
          both orders filling — the fill rates beside them are how you judge that.
        </p>
      </header>

      {/* Every view states its own age. The header chip says whether ingestion is alive;
          this says how old the numbers in THIS table are, which can be older still. */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-rule py-2 text-xs">
        <label className="flex items-center gap-2 sm:hidden">
          <span className="text-ink-faint">Sort</span>
          <select
            className="num rounded-sm border border-rule bg-surface px-2 py-1 text-ink"
            value={sort.key}
            onChange={(event) => setSort(sortByKey(sort, event.target.value as SortKey))}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded-sm border border-rule px-2 py-1 text-ink-dim"
            onClick={() =>
              setSort({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })
            }
            aria-label={sort.direction === "asc" ? "Sort descending" : "Sort ascending"}
          >
            {sort.direction === "asc" ? "▲" : "▼"}
          </button>
        </label>

        <span className="text-ink-faint">
          <span className="num text-ink-dim">{sorted.length}</span> bands
          {hiddenCount > 0 && (
            <>
              {" · "}
              <span className="num text-late">{hiddenCount}</span> over{" "}
              <span className="num">{formatCoins(settings.capital ?? 0)}</span> capital
              <button
                type="button"
                className="ml-1 text-accent hover:underline"
                onClick={() => updateSettings({ capital: null })}
              >
                clear
              </button>
            </>
          )}
        </span>

        {staleFor !== undefined && (
          <span className="ml-auto text-ink-faint">
            computed <span className="num">{formatAge(staleFor)}</span> ago
            {meta?.source === "kv" && <span className="ml-1">· precomputed</span>}
          </span>
        )}
      </div>

      {error !== undefined && <LoadError error={error} stale={rows !== undefined} />}

      {rows === undefined && loading && <TableSkeleton />}

      {rows !== undefined && rows.length === 0 && (
        <NoBandsYet skipped={skipped} meta={meta} now={now} />
      )}

      {rows !== undefined && rows.length > 0 && sorted.length === 0 && (
        <NothingAffordable
          noun="bands"
          hiddenCount={hiddenCount}
          onClear={() => updateSettings({ capital: null })}
        />
      )}

      {sorted.length > 0 && (
        <>
          <BandTable rows={visible} sort={sort} onSortChange={setSort} />
          {!showAll && sorted.length > visible.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-3 w-full rounded-sm border border-rule py-2 text-xs text-ink-dim hover:border-rule-strong hover:text-ink"
            >
              Show all {sorted.length} bands
            </button>
          )}
        </>
      )}
    </section>
  );
}
