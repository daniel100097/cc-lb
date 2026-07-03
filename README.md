# cc-lb

Load balancer / proxy for Claude Code accounts. Pool multiple Anthropic OAuth
(Pro/Max) accounts behind one endpoint, balance requests across them, manage it
all from a web dashboard.

Point Claude Code at it:

```sh
ANTHROPIC_BASE_URL=http://localhost:8484
```

- **Account/proxy logic** modeled on [better-ccflare](https://github.com/tombii/better-ccflare).
- **Load-balancing strategies + design language** modeled on [codex-lb](https://github.com/Soju06/codex-lb).

## Status

Bun server, SQLite persistence, account/OAuth APIs, Anthropic proxy failover, tRPC
dashboard, Docker, and CI are implemented. See [`plans/`](plans/) and
[`docs/research/`](docs/research/) for the design notes behind the implementation.

## Add accounts (planned)

Two ways, from the dashboard:
1. **Paste credentials JSON** — the contents of `~/.claude/.credentials.json`.
2. **Sign in with Claude** — OAuth (PKCE); paste back the returned `code#state`.

## Run (dev)

```sh
bun install
bun run build                # builds React dashboard into public/
bun run dev                  # server on :8484
```

The dashboard is built with Bun and Tailwind CLI from `frontend/` source files;
there is no Vite project or nested frontend package.

## Run (Docker)

```sh
docker compose up
```

The image is published to `ghcr.io/<owner>/cc-lb` by GitHub Actions on push to main.

## Security

`data/` holds the SQLite database with **plaintext OAuth tokens** — it is the
secret store. Protect its file permissions. Do not expose port 8484 publicly
without setting `DASHBOARD_PASSWORD` and/or keeping it on a private network. The
`/v1/*` proxy path is unauthenticated by default.

## Layout

```
src/        Bun server (proxy + REST API)
frontend/   Bun-built React 19 + Tailwind v4 + shadcn dashboard
plans/      implementation plan (start at plans/00-overview.md)
docs/       research on better-ccflare & codex-lb
```
