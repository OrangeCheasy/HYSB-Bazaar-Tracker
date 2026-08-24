# HYSB-BazzarTracker

Bazaar craft analytics for Hypixel SkyBlock — base→enchanted craft margins, diurnal price
patterns, and volume-adjusted profitability. Public, read-only, no accounts.

One Cloudflare Worker serves the SPA, the `/api/*` routes, and the ingestion crons.

## Setup

```bash
npm install
```

Create the two resources and paste the IDs into `wrangler.jsonc` — both fields currently
hold `REPLACE_ME_*` placeholders and **deploy will fail until they are real**:

```bash
npx wrangler d1 create bazaar             # → d1_databases[0].database_id
npx wrangler kv namespace create CACHE    # → kv_namespaces[0].id
npm run db:migrate                        # apply migrations/ to the remote D1
```

## Commands

| | |
|---|---|
| `npm run dev` | `wrangler dev` — Worker + local D1/KV |
| `npm run dev:web` | Vite alone, proxying `/api` to `wrangler dev` on :8787 |
| `npm run build` | `vite build` → `dist/client` |
| `npm test` | vitest over `packages/core` |
| `npm run typecheck` | worker + core + web |
| `npm run lint` | eslint |
| `npm run deploy` | `wrangler deploy` (CI does this — avoid running locally) |
| `npm run db:migrate` | apply migrations to remote D1 |
| `npm run db:migrate:local` | apply migrations to local D1 |
| `npm run backfill -- --tag COAL --days 30` | local-only history seed |

## Layout

```
packages/core/   Pure TS domain logic. Zero platform imports, zero I/O.
src/worker/      fetch + scheduled entry, ingest, rollup, precompute, api/, db/
web/             Vite + React SPA
migrations/      D1 SQL, numbered, forward-only
scripts/         Local-only Node scripts
docs/            ROADMAP.md (phase plan), DECISIONS.md (ADRs)
```

`CLAUDE.md` holds the durable rules and invariants — read §1 before touching any pricing
code.

## Deployment

Cloudflare Workers Builds is connected to this repo. A push to `main` builds and deploys
automatically. The Worker name in `wrangler.jsonc` must match the dashboard Worker
(`hysb-bazaartracker`) exactly, or the build fails.

Build command: `npm run build` · Deploy command: `npx wrangler deploy`

**Workers Builds does not run D1 migrations.** Run `npm run db:migrate` yourself whenever
you add one.

Workers Paid is required: the free plan's 10ms CPU cap cannot fit an ingest that parses
the full bazaar payload and writes ~1500 rows.

---

Not affiliated with or endorsed by Hypixel or Mojang. All figures are estimates, not
trading advice.
