import { useMemo, useState } from "react";
import { fetchScan } from "../api/endpoints.js";
import { useApi } from "../api/useApi.js";
import { LoadError, NothingAffordable, TableSkeleton } from "../ui/TableStates.js";
import { ScanTable } from "../scan/ScanTable.js";
import {
  DEFAULT_SCAN_SORT,
  capitalRequired,
  isSuspicious,
  scanSortByKey,
  sortScanRows,
  type ScanSort,
  type ScanSortKey,
} from "../scan/rank.js";
import { formatAge, formatCoins } from "../format.js";
import { queryString, toScanQuery } from "../settings/toQuery.js";
import { updateSettings, useSettings } from "../settings/store.js";
import { splitByCapital } from "../ui/capitalFilter.js";
import { useNow } from "../useNow.js";

/**
 * The craft scan: compaction and anvil merges in one ranked list.
 *
 * They share a list because they compete for the same capital (CLAUDE.md §8) — separate
 * leaderboards would hide the comparison that matters, which is "given the coins I have,
 * what is the best thing to do with them tonight".
 */

const RENDER_LIMIT = 150;

const SORT_OPTIONS: readonly { readonly key: ScanSortKey; readonly label: string }[] = [
  { key: "profitPerDay", label: "Profit / day" },
  { key: "marginPct", label: "Margin" },
  { key: "fillFeasibility", label: "Fill feasibility" },
  { key: "craftsPerDay", label: "Crafts / day" },
  { key: "hoursToFillOneCraft", label: "Hours to fill one" },
  { key: "capitalRequired", label: "Capital / day" },
  { key: "kind", label: "Craft type" },
  { key: "product", label: "Name" },
];

export function ScanView(): React.JSX.Element {
  const settings = useSettings();
  const now = useNow();
  const [sort, setSort] = useState<ScanSort>(DEFAULT_SCAN_SORT);
  const [showAll, setShowAll] = useState(false);

  const path = `/api/scan${queryString(toScanQuery(settings))}`;
  const { data, meta, error, loading } = useApi(path, (signal) => fetchScan(settings, signal));

  const { affordable, hiddenCount } = useMemo(
    () => splitByCapital(data ?? [], settings.capital, capitalRequired),
    [data, settings.capital],
  );
  const sorted = useMemo(() => sortScanRows(affordable, sort), [affordable, sort]);
  const visible = showAll ? sorted : sorted.slice(0, RENDER_LIMIT);

  const scored = sorted.filter((row) => row.analysis !== undefined);
  const suspect = scored.filter(isSuspicious).length;
  const unverified = sorted.filter((row) => !row.recipe.verified).length;
  const staleFor = meta !== undefined ? Math.max(0, now - meta.generatedAt) : undefined;

  return (
    <section>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-semibold tracking-tight text-ink">Crafts</h1>
        <p className="text-xs text-ink-dim">
          Compaction and anvil merges, ranked by profit per day — never by margin. Every margin
          is conditional on both sides filling; the fill figure beside it is how you judge that.
        </p>
      </header>

      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-rule py-2 text-xs">
        <label className="flex items-center gap-2 sm:hidden">
          <span className="text-ink-faint">Sort</span>
          <select
            className="num rounded-sm border border-rule bg-surface px-2 py-1 text-ink"
            value={sort.key}
            onChange={(event) =>
              setSort(scanSortByKey(sort, event.target.value as ScanSortKey))
            }
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
          <span className="num text-ink-dim">{scored.length}</span> scored
          {sorted.length > scored.length && (
            <>
              {" · "}
              <span className="num">{sorted.length - scored.length}</span> awaiting data
            </>
          )}
          {suspect > 0 && (
            <>
              {" · "}
              <span className="num text-outage">{suspect}</span> flagged, sorted below
            </>
          )}
        </span>

        {/* The unverified count is stated outright rather than left to be inferred from a
            marking that is on nearly every row. Every anvil recipe and every compaction
            ratio ships unverified, and a user should know that is the state of the whole
            table, not discover it row by row. */}
        {unverified > 0 && (
          <span className="text-ink-faint">
            <span className="num text-late">{unverified}</span> of{" "}
            <span className="num">{sorted.length}</span> ratios unverified
          </span>
        )}

        {hiddenCount > 0 && (
          <span className="text-ink-faint">
            <span className="num text-late">{hiddenCount}</span> over{" "}
            <span className="num">{formatCoins(settings.capital ?? 0)}</span> capital
            <button
              type="button"
              className="ml-1 text-accent hover:underline"
              onClick={() => updateSettings({ capital: null })}
            >
              clear
            </button>
          </span>
        )}

        {staleFor !== undefined && (
          <span className="ml-auto text-ink-faint">
            computed <span className="num">{formatAge(staleFor)}</span> ago
            {meta?.source === "kv" && <span className="ml-1">· precomputed</span>}
          </span>
        )}
      </div>

      {error !== undefined && <LoadError error={error} stale={data !== undefined} />}

      {data === undefined && loading && <TableSkeleton />}

      {data !== undefined && data.length === 0 && (
        <div className="border border-rule bg-surface px-4 py-6 text-sm">
          <h2 className="font-semibold text-ink">No recipes</h2>
          <p className="mt-2 text-ink-dim">
            The recipe table is empty. Compaction recipes arrive by migration and anvil edges
            are derived by the daily cron, so a database that has never run either has nothing
            to scan.
          </p>
        </div>
      )}

      {data !== undefined && data.length > 0 && sorted.length === 0 && (
        <NothingAffordable
          noun="crafts"
          hiddenCount={hiddenCount}
          onClear={() => updateSettings({ capital: null })}
        />
      )}

      {sorted.length > 0 && (
        <>
          <ScanTable rows={visible} sort={sort} onSortChange={setSort} />
          {!showAll && sorted.length > visible.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-3 w-full rounded-sm border border-rule py-2 text-xs text-ink-dim hover:border-rule-strong hover:text-ink"
            >
              Show all {sorted.length} crafts
            </button>
          )}
        </>
      )}
    </section>
  );
}
