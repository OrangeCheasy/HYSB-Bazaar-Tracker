import type { Column } from "./DataTable.js";

/**
 * A figure that may not be shown alone, and the figure that must sit beside it.
 *
 * Two of CLAUDE.md's non-negotiables have the same shape (§7.6, ROADMAP Phase 5):
 *
 *   - a **margin** never renders without its **fill feasibility** adjacent
 *   - a **band** never renders without its **hit-rate** adjacent
 *
 * and both add "not in a tooltip — adjacent". In session 5b that was kept by a component
 * that physically emitted both `<td>`s. Generalising the table would have dissolved that
 * guarantee back into a convention, so it is re-established here instead: this factory is
 * the ONLY way to declare either kind of column, and it returns a tuple of two. A lone
 * margin column is not constructible, because nothing else builds one.
 *
 * Returning adjacent entries in the column list is also what makes "adjacent" literal at
 * both widths — neighbouring cells on a desktop row, and neighbouring grid areas on a
 * phone.
 *
 * Why the rule exists at all: a p10 buy order sits unfilled ~90% of the time BY
 * CONSTRUCTION, and a craft margin is conditional on both sides of the trade filling. The
 * companion figure is the only thing on the row that says whether the headline number is
 * reachable.
 */
export function pairedColumns<Row>(
  value: Column<Row>,
  companion: Column<Row>,
): readonly [Column<Row>, Column<Row>] {
  return [value, companion];
}

/**
 * Flatten a column list that mixes plain columns and pairs.
 *
 * Written as its own function so a column list reads as the pairs it contains — the
 * grouping stays visible in the source, rather than being lost the moment the array is
 * spread.
 */
export function columnList<Row>(
  entries: readonly (Column<Row> | readonly [Column<Row>, Column<Row>])[],
): readonly Column<Row>[] {
  return entries.flatMap((entry) => (Array.isArray(entry) ? entry : [entry as Column<Row>]));
}
