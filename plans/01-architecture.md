# 01 — Architecture

## Runtime shape

Single Bun process, one port (default `8484`):

```
client (Claude Code, ANTHROPIC_BASE_URL=http://host:8484)
   │
   ▼
Bun.serve ──► /v1/*            → proxy pipeline → api.anthropic.com
          ──► /api/trpc        → dashboard tRPC API (accounts, settings, stats, requests)
          ──► /*               → static dashboard SPA (built by Bun into ./public)
```

Contrast with references:
- better-ccflare: Bun monorepo, many packages. We collapse to **one package**, folders instead of workspaces — "simple" is a requirement.
- codex-lb: Python FastAPI + separate Vite frontend built into `app/static`. We copy that build layout (frontend built into server-served static dir) but keep everything Bun.

## Directory layout

```
cc-lb/
├── src/                      # Bun server
│   ├── index.ts              # Bun.serve entry, router
│   ├── db/
│   │   ├── schema.ts         # bun:sqlite setup + migrations
│   │   └── accounts.ts       # account repository
│   ├── anthropic/
│   │   ├── oauth.ts          # PKCE, authorize URL, code exchange, refresh
│   │   ├── constants.ts      # client id, URLs, scopes, header names
│   │   └── headers.ts        # prepareHeaders / sanitize response headers
│   ├── proxy/
│   │   ├── handler.ts        # buffer body, select account, attempt loop
│   │   ├── rate-limit.ts     # parse anthropic-ratelimit-unified-*, cooldowns
│   │   └── stream.ts         # SSE tee/passthrough
│   ├── balancer/
│   │   ├── types.ts          # AccountState, strategy interface
│   │   └── strategies.ts     # pure selection functions (codex-lb style)
│   └── api/
│       ├── router.ts         # tRPC routers: accounts, settings, stats, requests
│       ├── server.ts         # fetch adapter
│       └── trpc.ts           # tRPC init
├── frontend/                 # Bun-built React 19 + Tailwind v4 + shadcn (new-york)
│   ├── src/ ...              # see 04-frontend-design.md
│   └── index.html            # copied into ./public during root build
├── public/                   # built SPA (gitignored)
├── data/                     # SQLite file lives here (volume-mounted in Docker)
├── docs/research/            # research documents
├── plans/                    # these files
├── Dockerfile
├── docker-compose.yml
└── .github/workflows/docker.yml
```

## Key architectural decisions

1. **Two-layer balancer, copied from codex-lb**: `src/balancer/strategies.ts` is *pure* (takes `AccountState[]`, returns winner — trivially testable); `src/proxy/handler.ts` is the stateful orchestrator (loads accounts, applies stickiness, marks failures). This is codex-lb's `app/core/balancer/logic.py` vs `app/modules/proxy/load_balancer.py` split.

2. **Buffer request body once, replay across failover attempts** — better-ccflare's `prepareRequestBody` pattern. Required because a failed attempt consumes the stream.

3. **SQLite via `bun:sqlite`**, WAL mode, single file `data/cc-lb.db`. Migrations = ordered SQL strings run at boot. Tables: `accounts`, `settings`, `sticky_sessions`, `request_log` (small, ring-buffer-pruned).

4. **In-memory runtime state** (in-flight refresh promises, consecutive-429 counters) lives in a module-level context object; DB is authoritative for `rate_limited_until`, tokens, pause state — mirrors both references.

5. **Settings in DB, edited via dashboard** (codex-lb pattern), not env vars. Env vars only for infra: `PORT`, `DB_PATH`, `DASHBOARD_PASSWORD` (optional).

## tRPC API surface (dashboard)

```
accounts.list                         list w/ status, usage, rate-limit info
accounts.import                       body: credentials JSON (+ name)
accounts.oauthBegin                   → { authUrl, sessionId }
accounts.oauthComplete                body: { sessionId, code } → account
accounts.update                       rename, priority, pause/resume
accounts.delete
settings.get / settings.update        strategy + knobs
stats                                 totals, per-account counters
requests.list / requests.options      paginated request log + filters
GET    /api/health                    liveness
```

## Proxy request lifecycle

1. Request in → path allowlist (`/v1/*`). Short-circuit Claude Code telemetry endpoints (`/api/event_logging/batch` → `{"success":true}`) like better-ccflare.
2. Buffer body. Derive sticky key (session affinity, plan 03).
3. Loop: pick account (strategy) → ensure fresh access token (refresh if < 30 min to expiry, deduped per account) → forward with rewritten headers → inspect response.
   - 2xx: stream back (tee for rate-limit sniffing + usage counters), clear error state. Done.
   - 401: try next account.
   - 429/529 or hard `anthropic-ratelimit-unified-status`: mark account cooled (min(reset header, backoff)), try next.
   - Network error: record error, try next.
4. Pool exhausted → 503 `pool_exhausted` JSON listing per-account `available_at`, plus `Retry-After` header.

Details per subsystem in plans 02–03.
