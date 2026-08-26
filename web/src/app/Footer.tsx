/**
 * CLAUDE.md §7 non-negotiables, rendered on every page because they are obligations
 * rather than decoration:
 *
 * 1. SkyCofl require a visible link back to sky.coflnet.com on any page using their data.
 * 2. The site must state it is not affiliated with or endorsed by Hypixel or Mojang.
 * 3. The site gives estimates, not advice.
 *
 * These live in the layout, not in a view, so no route can ship without them.
 */
export function Footer(): React.JSX.Element {
  return (
    <footer className="border-t border-rule px-4 py-5 text-xs leading-relaxed text-ink-faint sm:px-6">
      <div className="mx-auto flex max-w-[110rem] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          Live prices from the Hypixel API. Historical data via{" "}
          <a href="https://sky.coflnet.com" rel="noreferrer noopener" target="_blank">
            sky.coflnet.com
          </a>
          .
        </p>
        <p>
          Not affiliated with or endorsed by Hypixel or Mojang. Every figure is an estimate, not
          trading advice.
        </p>
      </div>
    </footer>
  );
}
