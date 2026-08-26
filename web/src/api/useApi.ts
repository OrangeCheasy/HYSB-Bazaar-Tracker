import { useEffect, useRef, useState } from "react";
import type { Meta } from "@core/index.js";
import { isAborted, type ApiResult } from "./client.js";

/**
 * Run a request when its key changes, aborting the one in flight.
 *
 * The key is a string identifying the request — in practice the URL, which already
 * encodes every input that can change the answer. That is why there is no dependency
 * array here: two calls with the same URL are the same request, and a settings change
 * that alters the query string changes the key by construction.
 *
 * `meta` is kept alongside the value rather than discarded, because every view has to
 * render how old its own numbers are — the header's freshness chip answers "is ingestion
 * alive", but only this answers "how old is the number I am about to trade on".
 *
 * `loading` is DERIVED, not stored: the state records which key produced it, and anything
 * whose key is no longer current is by definition stale. Setting a loading flag from
 * inside the effect would work but costs a second render pass on every input change, and
 * this hook backs tables that re-request whenever a setting moves.
 */
export interface ApiState<T> {
  readonly data: T | undefined;
  readonly meta: Meta | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
}

/** What one settled request left behind, and which key produced it. */
interface Settled<T> {
  readonly key: string;
  readonly data: T | undefined;
  readonly meta: Meta | undefined;
  readonly error: string | undefined;
}

export function useApi<T>(
  key: string,
  run: (signal: AbortSignal) => Promise<ApiResult<T>>,
): ApiState<T> {
  const [settled, setSettled] = useState<Settled<T> | undefined>(undefined);

  // `run` is a new closure on every render, so depending on it directly would refetch on
  // every render — including the render its own result causes. This effect is declared
  // BEFORE the fetching one so that when both run, the fetch sees the current closure:
  // effects run in declaration order.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });

  useEffect(() => {
    const controller = new AbortController();

    void runRef.current(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setSettled({ key, data: result.value, meta: result.meta, error: undefined });
      } else if (!isAborted(result)) {
        // Keep the previous data alongside the error: a table that empties itself because
        // one refresh failed has thrown away rows that are still true, just older. The
        // view renders both — the stale numbers and the reason they are stale.
        setSettled((prev) => ({
          key,
          data: prev?.data,
          meta: prev?.meta,
          error: result.error,
        }));
      }
    });

    return () => controller.abort();
  }, [key]);

  const isCurrent = settled?.key === key;
  return {
    data: settled?.data,
    meta: settled?.meta,
    // An error left by a superseded request is not this request's error.
    error: isCurrent ? settled.error : undefined,
    loading: !isCurrent,
  };
}
