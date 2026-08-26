/**
 * Every view is a stub in session 5a — the shell, routing and settings ship first so the
 * tables built on top of them have somewhere to live. Each stub names what belongs there
 * and, where the rule is non-negotiable, what it must render next to its numbers
 * (ROADMAP Phase 5).
 */
export function Placeholder({
  title,
  subject,
  children,
}: {
  readonly title: string;
  readonly subject?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="max-w-3xl py-6">
      <h1 className="text-lg font-semibold tracking-tight text-ink">
        {title}
        {subject !== undefined && <span className="num ml-2 text-ink-dim">{subject}</span>}
      </h1>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-ink-dim">{children}</div>
      <p className="mt-6 border-l-2 border-rule-strong pl-3 text-xs text-ink-faint">
        Not built yet. The shell, routing and settings landed first.
      </p>
    </section>
  );
}
