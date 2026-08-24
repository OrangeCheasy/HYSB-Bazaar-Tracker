import type { Env } from "../index.js";

/**
 * Standard response envelope. Every payload states how old it is — users making trades
 * on 40-minute-old data need to know that. See CLAUDE.md §5.
 */
export interface Meta {
  /** UTC epoch seconds the underlying data was generated. */
  generatedAt: number;
  /** UTC epoch seconds after which this payload should be considered stale. */
  staleAfter: number;
  source: "kv" | "d1" | "worker";
}

export function json<T>(data: T, meta: Meta, status = 200): Response {
  return new Response(JSON.stringify({ data, meta }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30",
    },
  });
}

export function errorResponse(message: string, status: number): Response {
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      data: null,
      error: message,
      meta: { generatedAt: now, staleAfter: now, source: "worker" satisfies Meta["source"] },
    }),
    { status, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

/**
 * Route handlers are thin: parse the request, read KV or D1, shape the envelope.
 * Business logic belongs in packages/core, SQL belongs in src/worker/db.
 */
export async function handleApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return errorResponse("method not allowed", 405);
  }

  switch (url.pathname) {
    case "/api/health": {
      const now = Math.floor(Date.now() / 1000);
      return json(
        { ok: true, environment: env.ENVIRONMENT },
        { generatedAt: now, staleAfter: now + 30, source: "worker" },
      );
    }

    default:
      return errorResponse("not found", 404);
  }
}
