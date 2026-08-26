import type { Meta } from "@core/index.js";
import type { Env } from "../index.js";
import { handleBandScan, handleBands } from "./bands.js";
import { handleCraft } from "./craft.js";
import { handleItemHistory, handleItemHours, handleItemStats } from "./item.js";
import { handleProducts } from "./products.js";
import { handleRecipes } from "./recipes.js";
import { handleScan } from "./scan.js";
import { handleStatus } from "./status.js";

/**
 * Standard response envelope. Every payload states how old it is — users making trades
 * on 40-minute-old data need to know that. See CLAUDE.md §5.
 *
 * Declared in `packages/core/src/wire.ts` and re-exported here so this module stays the
 * one place worker code imports it from. The web client imports the same type from core
 * directly: `web/` cannot reach into `src/worker/`, and a second hand-written copy of the
 * envelope over there would drift the first time a field is added on one side only.
 */
export type { Meta };

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
 * Wraps a route in Cloudflare's edge Cache API (ROADMAP Phase 4: "use the Cache API for
 * history ranges"). `Cache-Control` headers alone don't get a Worker's own `/api/*`
 * routes cached at the edge — that only happens via an explicit `caches.default` call or
 * a zone cache rule, neither of which existed here before.
 *
 * `caches` is a Workers-runtime global with no Node equivalent, so it is undefined under
 * plain vitest (see vitest.config.ts — no workers pool). Feature-detecting it lets this
 * degrade to "just compute" in tests instead of every history-route test needing a fake.
 */
async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  compute: () => Promise<Response>,
): Promise<Response> {
  if (typeof caches === "undefined") return compute();

  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await compute();
  if (response.ok) {
    // waitUntil: the cache write must not delay the response the caller is waiting on.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

/**
 * Route handlers are thin: parse the request, read KV or D1, shape the envelope.
 * Business logic belongs in packages/core, SQL belongs in src/worker/db.
 */
export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
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

  if (segments.length === 2 && segments[1] === "bands") {
    return handleBandScan(url, env);
  }

  if (segments.length === 2 && segments[1] === "products") {
    return handleProducts(env);
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
    return withEdgeCache(request, ctx, () =>
      handleItemHistory(decodeURIComponent(segments[2] ?? ""), url, env),
    );
  }

  if (segments.length === 4 && segments[1] === "item" && segments[3] === "hours") {
    return handleItemHours(decodeURIComponent(segments[2] ?? ""), url, env);
  }

  if (segments.length === 3 && segments[1] === "bands") {
    return handleBands(decodeURIComponent(segments[2] ?? ""), url, env);
  }

  if (segments.length === 3 && segments[1] === "craft") {
    return handleCraft(decodeURIComponent(segments[2] ?? ""), url, env);
  }

  return errorResponse("not found", 404);
}
