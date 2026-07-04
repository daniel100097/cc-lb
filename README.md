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

Accounts are added through the **Claude Code CLI login** only: cc-lb runs the
normal `claude` TUI in tmux, shows the login link, sends your pasted Claude code
back to the CLI, and adopts the generated `.credentials.json` into a persistent
per-account config dir under `./data/claude-accounts/<accountId>/`.

With Docker, the image includes the `claude` CLI and the dashboard drives this
flow from the **Add Account** dialog.

## Token refresh & usage (Claude CLI)

Claude Code owns each account's tokens. The `.credentials.json` in that account's
config dir is the **sole source of truth** — cc-lb reads it and never writes it.
When a request selects an account whose access token is expired (or inside the
30-minute safety window), cc-lb boots `claude` in tmux against that account's
config dir and runs `/usage`. That authenticated call makes the CLI refresh its
own token; cc-lb then re-reads the file. The `/usage` panel is parsed for 5-hour
and weekly utilization and shown per account on the dashboard, where a manual
**Refresh token & usage** button triggers the same probe on demand.

Probes are deduped per account (one in-flight at a time), globally capped, and
backed off on failure — no background polling. Requirements at runtime: `tmux`
and the `claude` CLI (both in the Docker image). Debug a live probe with
`tmux -S /tmp/cc-lb-claude-code.tmux attach -t cc-lb-probe-<hex>`. If the refresh
token is dead, the probe reaches the CLI login screen and the account is flagged
`needs_reauth`; re-add it through the login dialog.

Each request carries the routed account's **own Claude identity** — the
`machineID` (device id) and `accountUuid` (account id) from that account's
`.claude.json` — so upstream sees a device and account fingerprint consistent
with the account whose token is used, matching a native Claude Code call. The
manual device ID override is the fallback when the folder has no `machineID`;
`account_uuid` falls back to cc-lb's internal account id. Either way it is
location-scoped: an incoming `x-device-id` header is rewritten, and device-id /
account-uuid fields inside the JSON body are rewritten — each only when the
client sent one there. cc-lb never adds an identity signal to a location that
lacked one.

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
| `CLAUDE_ACCOUNTS_DIR` | `./data/claude-accounts` | Per-account Claude Code config dirs (each holds the CLI-managed `.credentials.json` token source). |
| `DASHBOARD_PASSWORD` | unset | When set, protects the SPA and `/api/trpc`; `/v1/*` remains unauthenticated. |

## Security

`data/` is the secret store: the SQLite database plus the per-account
`claude-accounts/<id>/.credentials.json` files that hold **plaintext OAuth
tokens** (Claude-Code-managed). Protect its file permissions. Do not expose port
8484 publicly without setting `DASHBOARD_PASSWORD` and/or keeping it on a private
network. The `/v1/*` proxy path is unauthenticated by default.

## Layout

```
src/        Bun server (proxy + tRPC API)
frontend/   Bun-built React 19 + Tailwind v4 + shadcn dashboard
plans/      implementation plan (start at plans/00-overview.md)
docs/       research on better-ccflare & codex-lb
```
