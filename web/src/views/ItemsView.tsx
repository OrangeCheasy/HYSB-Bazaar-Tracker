import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { ProductSummary } from "@core/index.js";
import { fetchProducts } from "../api/endpoints.js";
import { useApi } from "../api/useApi.js";
import { formatAge } from "../format.js";
import { displayTag } from "../tagName.js";
import { DataTable, type Column } from "../ui/DataTable.js";
import { LoadError, TableSkeleton } from "../ui/TableStates.js";
import { useNow } from "../useNow.js";

/**
 * The catalogue. Navigation, not analysis.
 *
 * Deliberately carries no prices. Two thousand products with a price each is a scan by
 * another name, and every figure on it would need the caveats a scan's figures carry —
 * which is a lot of qualification for a list whose only job is getting you to the right
 * page. The numbers live on the item's own page, where there is room to qualify them.
 *
 * Search is client-side over the whole list: the payload is one small row per product and
 * arrives in a single cached request, so filtering it in the browser is instant and costs
 * the API nothing.
 */

/** Rendered rows before "show all". The full catalogue runs to ~2,100 products. */
const RENDER_LIMIT = 100;

type SortKey = "tag" | "tier" | "lastSeen";

function matches(product: ProductSummary, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  // Both the readable name and the raw tag, because people arrive with either — "ultimate
  // wise" from the wiki, or ENCHANTMENT_ULTIMATE_WISE_5 copied out of another tool.
  return (
    product.tag.toLowerCase().includes(needle) ||
    displayTag(product.tag).toLowerCase().includes(needle)
  );
}

export function ItemsView(): React.JSX.Element {
  const now = useNow();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({
    key: "tag",
    direction: "asc",
  });
  const [showAll, setShowAll] = useState(false);

  const { data, meta, error, loading } = useApi("/api/products", (s) => fetchProducts(s));

  const filtered = useMemo(() => {
    const rows = (data ?? []).filter((p) => matches(p, query));
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === "lastSeen") return (a.lastSeen - b.lastSeen) * factor;
      if (sort.key === "tier") {
        const byTier = a.tier.localeCompare(b.tier) * factor;
        return byTier !== 0 ? byTier : displayTag(a.tag).localeCompare(displayTag(b.tag));
      }
      return displayTag(a.tag).localeCompare(displayTag(b.tag)) * factor;
    });
  }, [data, query, sort]);

  const visible = showAll ? filtered : filtered.slice(0, RENDER_LIMIT);

  const columns: readonly Column<ProductSummary>[] = [
    {
      key: "tag",
      label: "Item",
      area: "name",
      sortKey: "tag",
      align: "left",
      render: (row) => (
        <Link
          to={`/item/${encodeURIComponent(row.tag)}`}
          title={row.tag}
          className="text-ink hover:underline"
        >
          {displayTag(row.tag)}
        </Link>
      ),
    },
    {
      key: "tier",
      label: "History",
      area: "tier",
      // Tier is a storage decision, but its consequence is what a reader cares about, so
      // the column says the consequence (CLAUDE.md §2).
      title:
        "Tier A keeps five-minute snapshots; Tier B keeps hourly rows only, so its charts are coarser",
      sortKey: "tier",
      align: "right",
      cellClassName: "text-xs text-ink-dim",
      render: (row) => (row.tier === "A" ? "5-minute" : "hourly"),
    },
    {
      key: "lastSeen",
      label: "Last seen",
      area: "seen",
      title: "When this tag last appeared in the upstream payload",
      sortKey: "lastSeen",
      align: "right",
      cellClassName: (row) =>
        // A product that stopped appearing upstream is still listed, and its staleness is
        // the useful thing about it — a delisted item looks identical otherwise.
        `num text-xs ${now - row.lastSeen > 86_400 ? "text-late" : "text-ink-faint"}`,
      render: (row) => `${formatAge(Math.max(0, now - row.lastSeen))} ago`,
    },
  ];

  return (
    <section>
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-base font-semibold tracking-tight text-ink">Items</h1>
        <p className="text-xs text-ink-dim">
          Every tracked product. Open one for its price history, order-book depth and volume.
        </p>
      </header>

      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-rule py-2 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-ink-faint">Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="coal, sharpness, ENCHANTED_"
            className="w-48 rounded-sm border border-rule bg-surface px-2 py-1 text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />
        </label>

        <span className="text-ink-faint">
          <span className="num text-ink-dim">{filtered.length}</span>
          {data !== undefined && filtered.length !== data.length && (
            <>
              {" of "}
              <span className="num">{data.length}</span>
            </>
          )}{" "}
          items
        </span>

        {meta !== undefined && (
          <span className="ml-auto text-ink-faint">
            catalogue as of{" "}
            <span className="num">{formatAge(Math.max(0, now - meta.generatedAt))}</span> ago
          </span>
        )}
      </div>

      {error !== undefined && <LoadError error={error} stale={data !== undefined} />}
      {data === undefined && loading && <TableSkeleton />}

      {data !== undefined && filtered.length === 0 && (
        <div className="border border-rule bg-surface px-4 py-6 text-sm">
          <h2 className="font-semibold text-ink">Nothing matches “{query}”</h2>
          <p className="mt-2 text-ink-dim">
            Search covers both the readable name and the raw bazaar tag. If you are looking for
            an enchanted book, try the enchant name — “sharpness” rather than “ENCHANTMENT”.
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <>
          <DataTable
            rows={visible}
            columns={columns}
            sort={sort}
            onSortChange={(key) =>
              setSort((current) =>
                current.key === key
                  ? {
                      key: current.key,
                      direction: current.direction === "asc" ? "desc" : "asc",
                    }
                  : { key: key as SortKey, direction: "asc" },
              )
            }
            rowKey={(row) => row.tag}
            // Two lines would waste space on rows this thin: name on the left, the two
            // small facts on the right, one line each.
            mobileAreas={`"name name tier seen"`}
            mobileColumns={4}
          />
          {!showAll && filtered.length > visible.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="mt-3 w-full rounded-sm border border-rule py-2 text-xs text-ink-dim hover:border-rule-strong hover:text-ink"
            >
              Show all {filtered.length} items
            </button>
          )}
        </>
      )}
    </section>
  );
}
