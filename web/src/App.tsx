import { useEffect, useState } from "react";

interface Envelope<T> {
  data: T;
  meta: { generatedAt: number; staleAfter: number; source: string };
}

type Health = { ok: boolean; environment: string };

export function App() {
  const [status, setStatus] = useState<string>("checking…");

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/health", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: Envelope<Health>) => setStatus(`worker up · ${body.data.environment}`))
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setStatus("worker unreachable");
      });

    return () => controller.abort();
  }, []);

  return (
    <main>
      <h1>Bazaar Craft Analytics</h1>
      <p className="tagline">
        Base to enchanted craft margins, diurnal price patterns, and volume-adjusted
        profitability for the Hypixel SkyBlock bazaar.
      </p>
      <p className="status">
        <span className="dot" aria-hidden="true" />
        {status}
      </p>

      <footer>
        {/*
          CLAUDE.md §7 non-negotiables. The Coflnet link is required on any page using
          their data; it is here from the start so it cannot be forgotten later.
        */}
        <p>
          Historical data via <a href="https://sky.coflnet.com">sky.coflnet.com</a>.
        </p>
        <p>
          Not affiliated with or endorsed by Hypixel or Mojang. All figures are estimates,
          not trading advice.
        </p>
      </footer>
    </main>
  );
}
