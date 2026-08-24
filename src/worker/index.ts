import { handleApi } from "./api/index.js";
import { runDailyRollup } from "./rollup.js";
import { runHourlyRollup } from "./rollup.js";
import { runIngest } from "./ingest.js";
import { runPrecompute } from "./precompute.js";

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  HYPIXEL_BAZAAR_URL: string;
}

/**
 * Cron expressions, kept as constants so the scheduled handler and wrangler.jsonc
 * cannot drift apart silently. These must match `triggers.crons` exactly.
 */
const CRON_INGEST = "*/5 * * * *";
const CRON_HOURLY = "7 * * * *";
const CRON_DAILY = "23 4 * * *";

export default {
  /**
   * `run_worker_first: ["/api/*"]` means non-API requests are served straight from the
   * asset store and never reach this handler. The ASSETS fallback below is belt-and-braces.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  /**
   * One scheduled handler, branching on which cron fired. Splitting the work this way
   * keeps each invocation's CPU budget separate — see CLAUDE.md §3.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case CRON_INGEST:
        ctx.waitUntil(runIngest(env));
        return;

      case CRON_HOURLY:
        // Rollup first, then precompute — precompute reads what the rollup just wrote.
        ctx.waitUntil(runHourlyRollup(env).then(() => runPrecompute(env)));
        return;

      case CRON_DAILY:
        ctx.waitUntil(runDailyRollup(env));
        return;

      default:
        console.error(`unrecognised cron fired: ${event.cron}`);
        return;
    }
  },
} satisfies ExportedHandler<Env>;
