import { useEffect, useState } from "react";
import { fetchStatus } from "../api/endpoints.js";
import { useApi } from "../api/useApi.js";
import { formatAge, formatInstant } from "../format.js";
import { useSettings } from "../settings/store.js";

/**
 * How old the data is, in the header, always visible — not in a tooltip (ROADMAP Phase 5).
 *
 * Reads `/api/status`, whose `dataAgeSeconds` is measured from the last SUCCESSFUL ingest
 * rather than the last attempt: a cron failing every five minutes always has a "recent"
 * attempt while no new data has landed, and this component exists precisely to make that
 * visible instead of averaging it away (CLAUDE.md §3b).
 *
 * The chip is about ingestion being alive. It is NOT the age of any particular view's
 * numbers — each view renders its own payload's `meta`, which can be older still.
 */

/** Ingest runs every 5 minutes, so anything under ~11 minutes is one missed tick at worst
 *  and normal. Past 30 minutes several ticks have failed and this is an outage a user
 *  must not trade on without knowing. */
const LATE_AFTER_SECONDS = 11 * 60;
const OUTAGE_AFTER_SECONDS = 30 * 60;

/** Matches the route's own 15s `Cache-Control`. Polling faster only re-reads the same
 *  cached answer; polling much slower would let a fresh outage sit unreported. */
const POLL_INTERVAL_MS = 60_000;

type Freshness = "fresh" | "late" | "outage" | "unknown";

export function freshnessOf(ageSeconds: number | null | undefined): Freshness {
  if (ageSeconds === null || ageSeconds === undefined) return "unknown";
  if (ageSeconds >= OUTAGE_AFTER_SECONDS) return "outage";
  if (ageSeconds >= LATE_AFTER_SECONDS) return "late";
  return "fresh";
}

const DOT_CLASS: Record<Freshness, string> = {
  fresh: "bg-fresh",
  late: "bg-late",
  outage: "bg-outage",
  unknown: "bg-ink-faint",
};

const TEXT_CLASS: Record<Freshness, string> = {
  fresh: "text-ink-dim",
  late: "text-late",
  outage: "text-outage",
  unknown: "text-ink-faint",
};

export function DataAge(): React.JSX.Element {
  const settings = useSettings();
  // A counter that ticks on an interval, used only as a dependency: it re-runs the
  // request rather than holding any state of its own.
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPoll((n) => n + 1), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // The poll counter is part of the key so each tick is a distinct request rather than a
  // cache hit on the previous one.
  const { data, error } = useApi(`/api/status#${poll}`, (signal) => fetchStatus(signal));

  if (error !== undefined && data === undefined) {
    return (
      <span
        className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-outage"
        role="status"
      >
        <span className="size-1.5 rounded-full bg-outage" aria-hidden />
        status unavailable
      </span>
    );
  }

  const age = data?.dataAgeSeconds ?? null;
  const freshness = freshnessOf(age);
  // Short enough to sit in a 375px header without wrapping. The long form is in the title.
  const label = age === null ? "no data yet" : `${formatAge(age)} old`;
  const title =
    data?.lastIngestAt != null
      ? `Last successful ingest ${formatInstant(data.lastIngestAt, settings.timeZone)}`
      : "No successful ingest is on record";

  return (
    <span
      className={`inline-flex items-center gap-2 whitespace-nowrap text-xs ${TEXT_CLASS[freshness]}`}
      title={title}
      role="status"
    >
      <span className={`size-1.5 rounded-full ${DOT_CLASS[freshness]}`} aria-hidden />
      <span className="hidden sm:inline text-ink-faint">data</span>
      <span className="num">{label}</span>
      {freshness === "outage" && (
        <span className="hidden md:inline">— ingestion may be down</span>
      )}
    </span>
  );
}
