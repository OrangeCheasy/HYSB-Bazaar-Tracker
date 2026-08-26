import { useSyncExternalStore } from "react";

/**
 * The current time, as UTC epoch seconds, that a component may read during render.
 *
 * `Date.now()` in a render body is impure — it returns something different on every
 * re-render, so "computed 4m ago" would silently update whenever the component happened to
 * re-render for an unrelated reason, and stay frozen when it did not. Reading it from a
 * store fixes both halves: every component sees the same instant, and it advances on a
 * schedule instead of on render luck.
 *
 * The visible benefit is that a stale-data age ticks upward on its own. A table left open
 * on a second monitor while the cron dies should not keep claiming the data is four
 * minutes old.
 */

/** Evaluated once at module load — not during a render. */
let snapshot = Math.floor(Date.now() / 1000);

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

/** Ages are rendered at minute resolution or coarser, so a finer tick would re-render for
 *  nothing. */
const TICK_MS = 30_000;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    snapshot = Math.floor(Date.now() / 1000);
    for (const l of listeners) l();
  }, TICK_MS);

  return () => {
    listeners.delete(listener);
    // No subscribers, no timer: nothing is watching the clock, so nothing should be
    // waking the tab up to look at it.
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return snapshot;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
