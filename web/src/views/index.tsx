import { useParams } from "react-router";
import { Placeholder } from "./Placeholder.js";

/**
 * Route stubs. Each says what the view will hold and which companion number the finished
 * version is not allowed to omit — a margin never renders without its fill feasibility, a
 * band never without its hit-rate (CLAUDE.md §7.6, ROADMAP Phase 5).
 */

export function ItemsView(): React.JSX.Element {
  return (
    <Placeholder title="Items">
      <p>Search across every tracked product; open one for its full history.</p>
    </Placeholder>
  );
}

export function ItemDetailView(): React.JSX.Element {
  const { tag } = useParams();
  return (
    <Placeholder title="Item" subject={tag}>
      <p>Ask and bid history, order-book depth, volume and volatility across 1d, 7d and 30d.</p>
    </Placeholder>
  );
}

export function NotFoundView(): React.JSX.Element {
  return (
    <Placeholder title="Not found">
      <p>No such page.</p>
    </Placeholder>
  );
}
