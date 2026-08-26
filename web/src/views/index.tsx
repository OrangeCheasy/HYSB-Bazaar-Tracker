import { useParams } from "react-router";
import { Placeholder } from "./Placeholder.js";

/**
 * Route stubs. Each says what the view will hold and which companion number the finished
 * version is not allowed to omit — a margin never renders without its fill feasibility, a
 * band never without its hit-rate (CLAUDE.md §7.6, ROADMAP Phase 5).
 */

export function BandDetailView(): React.JSX.Element {
  const { tag } = useParams();
  return (
    <Placeholder title="Band" subject={tag}>
      <p>
        Price over the trailing window with both bands drawn as horizontal lines, so &ldquo;how
        often did price touch this&rdquo; is answered visually rather than asserted.
      </p>
      <p>
        Week count is stated plainly. Nothing here rests on more than four weeks — the whole
        dataset is a rolling 30 days.
      </p>
    </Placeholder>
  );
}

export function ScanView(): React.JSX.Element {
  return (
    <Placeholder title="Crafts">
      <p>
        Compaction and anvil merges in one list ranked by profit per day, never by margin. They
        compete for the same capital, so splitting them would hide the comparison that matters.
      </p>
      <p>
        Craft type is a visible column. Unverified ratios are marked — every anvil recipe starts
        unverified, so that marking is the common case rather than an edge one.
      </p>
    </Placeholder>
  );
}

export function CraftDetailView(): React.JSX.Element {
  const { baseTag } = useParams();
  return (
    <Placeholder title="Craft" subject={baseTag}>
      <p>
        Three scenarios side by side, price chart with the buy and sell windows shaded, the
        hour-of-day profile, and each warning flag explained in plain language.
      </p>
      <p>
        For anvil merges: the chosen entry level, and what the alternatives would have cost.
      </p>
    </Placeholder>
  );
}

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
