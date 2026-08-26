import { Link } from "react-router";

export function NotFoundView(): React.JSX.Element {
  return (
    <section className="max-w-2xl py-8">
      <h1 className="text-base font-semibold tracking-tight text-ink">Not found</h1>
      <p className="mt-2 text-sm text-ink-dim">
        No such page. The <Link to="/">weekly bands</Link> are the place to start.
      </p>
    </section>
  );
}
