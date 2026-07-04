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

Bun server, SQLite persistence, account/token APIs, Anthropic proxy failover, tRPC
dashboard, Docker, and CI are implemented. See [`plans/`](plans/) and
[`docs/research/`](docs/research/) for the design notes behind the implementation.

## Add Accounts

Two ways, from the dashboard:
1. **Paste credentials JSON** — the contents of `~/.claude/.credentials.json`.
2. **Claude Code CLI login** — cc-lb runs the normal `claude` TUI in tmux, displays the login link, sends your pasted Claude code back to the CLI, and imports the generated `.credentials.json`.

With Docker, the image includes the `claude` CLI and the dashboard drives this
flow from the **Claude Code CLI** tab.

Each account can also set an optional device ID override. cc-lb only applies it
when the incoming request already includes `x-device-id` or a device ID field in
the JSON body; it never adds a device ID signal to requests that lack one.

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

The image is published to `ghcr.io/daniel100097/cc-lb` by GitHub Actions on push to main.

## Environment

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8484` | Bun server port. |
| `DB_PATH` | `./data/cc-lb.db` | SQLite database location. |
| `DASHBOARD_PASSWORD` | unset | When set, protects the SPA and `/api/trpc`; `/v1/*` remains unauthenticated. |

## Security

`data/` holds the SQLite database with **plaintext OAuth tokens** — it is the
secret store. Protect its file permissions. Do not expose port 8484 publicly
without setting `DASHBOARD_PASSWORD` and/or keeping it on a private network. The
`/v1/*` proxy path is unauthenticated by default.

## Layout

```
src/        Bun server (proxy + tRPC API)
frontend/   Bun-built React 19 + Tailwind v4 + shadcn dashboard
plans/      implementation plan (start at plans/00-overview.md)
docs/       research on better-ccflare & codex-lb
```
