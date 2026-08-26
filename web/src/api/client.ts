import type { Envelope, ErrorEnvelope, Meta } from "@core/index.js";

/**
 * The typed fetch layer. Everything the app knows about `/api/*` goes through here.
 *
 * Three things it is careful about, all of them CLAUDE.md rules rather than preference:
 *
 * 1. **`meta` is passed through untouched.** The KV-backed routes serve their stored meta
 *    verbatim so a stopped cron shows a `staleAfter` in the past; regenerating or
 *    "fixing" it on this side would erase the only evidence ingestion has died.
 * 2. **The server's error text is shown, not replaced.** `errorResponse` writes messages
 *    that name the offending parameter ("'tax' must be between 0 and 0.5 — a fraction, so
 *    1.25% is 0.0125; got 1.25"). Anything this client invented would be worse.
 * 3. **Errors are returned, not thrown** — the same typed-result convention core uses.
 *    Throwing at a boundary is fine; making every caller write a try/catch is not.
 */

export interface ApiOk<T> {
  readonly ok: true;
  readonly value: T;
  readonly meta: Meta;
}

export interface ApiErr {
  readonly ok: false;
  /** Shown to the user as-is when it came from the server. */
  readonly error: string;
  /** HTTP status, or 0 when the request never got an answer (offline, DNS, abort). */
  readonly status: number;
}

export type ApiResult<T> = ApiOk<T> | ApiErr;

/** Thrown by `AbortController`. Callers treat it as "ignore", not "show an error". */
export const ABORTED = "aborted";

export function isAborted(result: ApiResult<unknown>): boolean {
  return !result.ok && result.error === ABORTED;
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  );
}

function isEnvelope<T>(body: unknown): body is Envelope<T> {
  return (
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    "meta" in body &&
    typeof (body as { meta: unknown }).meta === "object"
  );
}

/**
 * `path` is an absolute `/api/...` path. Same-origin always: the client calls only
 * `/api/*` (CLAUDE.md §7.4), and no user request may reach an upstream API (§2).
 */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { accept: "application/json" } });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { ok: false, error: ABORTED, status: 0 };
    }
    return { ok: false, error: "could not reach the server", status: 0 };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: `the server returned something that is not JSON (HTTP ${response.status})`,
      status: response.status,
    };
  }

  if (!response.ok) {
    // The server's own sentence, verbatim — see the note at the top of this file.
    const error = isErrorEnvelope(body)
      ? body.error
      : `request failed (HTTP ${response.status})`;
    return { ok: false, error, status: response.status };
  }

  if (!isEnvelope<T>(body)) {
    return {
      ok: false,
      error: "the server returned an unexpected shape",
      status: response.status,
    };
  }

  return { ok: true, value: body.data, meta: body.meta };
}
