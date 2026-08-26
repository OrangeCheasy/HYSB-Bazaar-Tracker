import { NavLink } from "react-router";
import { DataAge } from "./DataAge.js";

/**
 * The header is furniture, so it stays short: identity, the three views, freshness, and
 * the settings trigger. Freshness sits in the bar itself rather than inside a view —
 * whatever page you are on, how old the data is must be on screen.
 */

const NAV = [
  { to: "/", label: "Bands", end: true },
  { to: "/scan", label: "Crafts", end: false },
  { to: "/items", label: "Items", end: false },
] as const;

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    "px-2 py-1 text-sm transition-colors",
    isActive ? "text-ink" : "text-ink-dim hover:text-ink",
    // An underline rather than a filled pill: it marks the active view without adding a
    // second surface colour to a page that is meant to read as one dense sheet.
    isActive ? "border-b-2 border-accent" : "border-b-2 border-transparent",
  ].join(" ");
}

export function Header({ onOpenSettings }: { onOpenSettings: () => void }): React.JSX.Element {
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-ground/95 backdrop-blur">
      <div className="mx-auto flex max-w-[110rem] items-center gap-3 px-4 py-2 sm:px-6">
        <NavLink to="/" className="shrink-0 text-sm font-semibold tracking-tight text-ink">
          bazaar
          <span className="text-ink-faint">.liamthemo.com</span>
        </NavLink>

        <nav className="flex items-center gap-1" aria-label="Views">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <DataAge />
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-sm border border-rule px-2 py-1 text-xs text-ink-dim transition-colors hover:border-rule-strong hover:text-ink"
          >
            Settings
          </button>
        </div>
      </div>
    </header>
  );
}
