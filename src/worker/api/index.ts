import type { Env } from "../index.js";
import { handleCraft } from "./craft.js";
import { handleItemHistory, handleItemHours, handleItemStats } from "./item.js";
import { handleRecipes } from "./recipes.js";
import { handleScan } from "./scan.js";
import { handleStatus } from "./status.js";

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

/**
 * `cacheControl` has no default on purpose: every route below sets one deliberately,
 * with a comment explaining why that TTL and not another (task requirement, and
 * CLAUDE.md's "every response states how old it is" extends to how long a cache is
 * allowed to keep serving it).
 */
export function json<T>(data: T, meta: Meta, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify({ data, meta }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl,
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

  // Split routing rather than a switch on the full pathname: three routes carry a path
  // parameter (`/api/item/:tag`, `/api/item/:tag/history`, `/api/item/:tag/hours`,
  // `/api/craft/:baseTag`), and a switch on the literal string can't express those.
  const segments = url.pathname.split("/").filter(Boolean); // ["api", "item", "TAG", ...]

  if (segments[0] !== "api") return errorResponse("not found", 404);

  if (segments.length === 2 && segments[1] === "health") {
    const now = Math.floor(Date.now() / 1000);
    return json(
      { ok: true, environment: env.ENVIRONMENT },
      { generatedAt: now, staleAfter: now + 30, source: "worker" },
      200,
      // Static payload, no upstream data behind it — a generous TTL costs nothing and
      // this is the one route a status page might poll often.
      "public, max-age=30",
    );
  }

  if (segments.length === 2 && segments[1] === "scan") {
    return handleScan(url, env);
  }

  if (segments.length === 2 && segments[1] === "recipes") {
    return handleRecipes(env);
  }

  if (segments.length === 2 && segments[1] === "status") {
    return handleStatus(env);
  }

  if (segments.length === 3 && segments[1] === "item") {
    return handleItemStats(decodeURIComponent(segments[2] ?? ""), env);
  }

  if (segments.length === 4 && segments[1] === "item" && segments[3] === "history") {
    return handleItemHistory(decodeURIComponent(segments[2] ?? ""), url, env);
  }

  if (segments.length === 4 && segments[1] === "item" && segments[3] === "hours") {
    return handleItemHours(decodeURIComponent(segments[2] ?? ""), url, env);
  }

  if (segments.length === 3 && segments[1] === "craft") {
    return handleCraft(decodeURIComponent(segments[2] ?? ""), url, env);
  }

  return errorResponse("not found", 404);
}
