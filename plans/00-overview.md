# cc-lb — Plan Overview

**Goal:** A load balancer / proxy for Claude Code accounts. Pool multiple Anthropic OAuth (Pro/Max) accounts, expose one endpoint, balance requests across accounts, with a web dashboard for managing accounts and routing.

In one sentence: **the account/proxy logic of better-ccflare, the load-balancing sophistication and visual design of codex-lb, in one simple Bun app.**

## Sources

| Question | Answered in |
|---|---|
| How better-ccflare talks to Anthropic (OAuth, refresh, proxying, rate limits, failover) | [docs/research/better-ccflare-anthropic.md](../docs/research/better-ccflare-anthropic.md) |
| How codex-lb load-balances (strategies, account states, stickiness, health tiers) | [docs/research/codex-lb-load-balancing.md](../docs/research/codex-lb-load-balancing.md) |
| codex-lb design language (tokens, layout, components) | [docs/research/codex-lb-design-language.md](../docs/research/codex-lb-design-language.md) |

## Core requirements

1. **Bun + React + shadcn/ui** app — Bun serves both the proxy API and the built dashboard SPA.
2. **Add Claude Code accounts two ways:**
   - Paste/upload a **credentials JSON** (e.g. `~/.claude/.credentials.json` contents: `claudeAiOauth.{accessToken,refreshToken,expiresAt,scopes}`).
   - **Direct OAuth** from the dashboard: generate the claude.ai authorize URL (PKCE), user pastes back the `code#state`, server exchanges it.
3. **Proxy** `/v1/messages` (and other Anthropic paths) to `api.anthropic.com` with per-account Bearer tokens, SSE streaming passthrough.
4. **Load balancing** with selectable strategies + rate-limit-aware failover (see plan 03).
5. **Settings UI** for strategy, per-account priority/pause, etc.
6. **Dockerfile + docker-compose + GitHub Actions** building/pushing the image to GHCR.
7. **Design language copied from codex-lb** (see plan 04).

## Plan files

- [01-architecture.md](01-architecture.md) — project layout, runtime, DB, API surface
- [02-accounts-and-auth.md](02-accounts-and-auth.md) — credentials JSON import + OAuth flow + token refresh
- [03-load-balancing.md](03-load-balancing.md) — strategies, account state machine, failover
- [04-frontend-design.md](04-frontend-design.md) — dashboard pages + copied codex-lb design system
- [05-docker-and-ci.md](05-docker-and-ci.md) — Dockerfile, compose, GHCR workflow
- [06-milestones.md](06-milestones.md) — build order

## Non-goals (v1)

- No Postgres (SQLite via `bun:sqlite` only).
- No multi-node clustering, leader election, prompt-cache-key affinity beyond simple session stickiness.
- No usage analytics/charts beyond basic counters (can add recharts later).
- No console/API-key mode — OAuth (Pro/Max) accounts only in v1.
