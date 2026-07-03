# 06 — Milestones (build order)

Build in dependency order; each milestone is independently testable.

## M1 — Scaffold & DB
- Bun project (`bun init`), `bun:sqlite` schema + migrations (plan 01/02 tables).
- `Bun.serve` router: `/api/health`, static SPA fallback stub.
- Account repository (CRUD).
- **Done when:** server boots, health returns 200, DB file created.

## M2 — Accounts & Auth
- `src/anthropic/constants.ts`, `oauth.ts` (PKCE, authorize URL, exchange, refresh).
- `POST /api/accounts/import` (credentials JSON).
- `POST /api/accounts/oauth/begin` + `/complete`.
- Token refresh with per-account dedup + backoff.
- **Done when:** can add an account both ways; refresh works against a near-expiry token.

## M3 — Proxy pipeline (single account)
- Body buffering, header rewrite (`headers.ts`), forward to `api.anthropic.com`.
- SSE streaming passthrough (tee), response header sanitize.
- Telemetry endpoint short-circuits.
- **Done when:** `ANTHROPIC_BASE_URL=http://localhost:8484` in Claude Code works end-to-end through one account.

## M4 — Load balancing & failover
- `src/balancer/` pure strategies + `types.ts`.
- Rate-limit parsing + `applyCooldown`, failover loop across accounts.
- Session window tracking + sticky sessions.
- Settings table + `GET/PATCH /api/settings`.
- **Done when:** killing/limiting one account transparently fails over; strategy switch changes distribution.

## M5 — Dashboard
- Vite + React + Tailwind v4 + shadcn scaffold; copy codex-lb `index.css` + `components.json`.
- Layout shell (top bar + footer), Dashboard / Accounts / Settings pages.
- Add Account dialog (both tabs). react-query data layer.
- **Done when:** full account lifecycle + settings editable from the UI.

## M6 — Docker & CI
- Dockerfile (multi-stage), docker-compose, GHCR workflow (plan 05).
- README: setup, env vars, security note on `data/`.
- **Done when:** `docker compose up` serves a working app; push to main publishes `ghcr.io/daniel100097/cc-lb:latest`.

## Suggested order of first PRs
1. M1 + repo scaffold (this init).
2. M2 auth.
3. M3 proxy.
4. M4 balancing.
5. M5 UI.
6. M6 ship.
