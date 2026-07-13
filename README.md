# cc-lb

Local load balancer and dashboard for Claude Code OAuth accounts.

cc-lb gives Claude Code one local Anthropic-compatible endpoint while routing
requests across a pool of Claude Code accounts. It handles account login,
token refresh, permanent chat affinity, API keys, request logs, and
basic usage analytics.

This project is intended for private/local deployments. The `data/` directory
contains plaintext Claude Code credentials and should be treated as a secret
store.

## Features

- `/v1/*` proxy endpoint restricted to the bundled Claude Code version.
- Web dashboard for accounts, routing settings, API keys, sticky sessions, and
  request logs.
- Account onboarding through the normal `claude` CLI login flow.
- Token refresh and usage probes driven by `claude` in `tmux`.
- Permanent per-chat account binding across errors, rate limits, restarts, and
  idle periods.
- Routing strategies: `priority`, `round_robin`, `noisy_round_robin`,
  `least_used`, `weighted_random`, and `session_reset_drain`.
- Optional proxy API-key enforcement with account scoping and model filters.
- Optional dashboard password for the SPA and tRPC API.
- SQLite persistence with Bun, React, Tailwind, and Docker support.

## Quick Start

Run with Docker:

```sh
docker compose up
```

Open the dashboard:

```text
http://localhost:8484
```

Add accounts from the dashboard, then point Claude Code at cc-lb:

```sh
export ANTHROPIC_BASE_URL=http://localhost:8485
export ANTHROPIC_AUTH_TOKEN=anything
```

The dashboard and its API listen on port `8484`. Claude Code proxy traffic
listens separately on port `8485`.

When API-key auth is enabled in Settings, use a dashboard-generated key as
`ANTHROPIC_AUTH_TOKEN` instead.

## Docker Compose Example

```yaml
services:
  cc-lb:
    image: ghcr.io/daniel100097/cc-lb:latest
    ports:
      - "8484:8484"
      - "8485:8485"
    volumes:
      - ./data:/app/data
    environment:
      DASHBOARD_PORT: "8484"
      PROXY_PORT: "8485"
      DB_PATH: /app/data/cc-lb.db
      CLAUDE_CONFIG_DIR: /app/data/claude
      CLAUDE_ACCOUNTS_DIR: /app/data/claude-accounts
      # DASHBOARD_PASSWORD: changeme
    restart: unless-stopped
```

## Local Development

Prerequisites:

- Bun
- `tmux`
- Claude Code CLI available through this repo's dependencies

Install and run:

```sh
bun install
bun run build
bun run dev
```

Useful commands:

```sh
bun run dev:server   # run only the Bun server
bun run typecheck
bun run lint
bun run test
bun run test:e2e
```

With the default development configuration, the dashboard is available at
`http://localhost:8484` and the Claude Code proxy at
`http://localhost:8485`.

The React dashboard lives in `frontend/` and builds directly into `public/` with
Bun and Tailwind CLI. There is no Vite project.

## Accounts

Accounts are added through Claude Code CLI login. The dashboard starts `claude`
inside `tmux`, shows the Claude login URL, accepts the pasted code, and adopts
the generated Claude config into:

```text
data/claude-accounts/<accountId>/
```

For each account, `.credentials.json` is the source of truth for OAuth tokens.
cc-lb reads that file but does not write token values itself. When an account
needs refresh, cc-lb runs `claude` against that account's config directory and
uses `/usage` to let the CLI refresh its own credentials.

The Docker image includes `tmux` and the Claude Code CLI.

To inspect a live Claude CLI pane:

```sh
tmux -S /tmp/cc-lb-claude-code.tmux attach -t cc-lb-probe-<hex>
```

## Routing

Incoming proxy requests go to `/v1/*` on the dedicated proxy port (default
`8485`). cc-lb selects an available account, rewrites the outbound auth header
to that account's OAuth token, and forwards the request to Anthropic. The proxy
port serves only proxy traffic, local telemetry acknowledgements, and its
health endpoint. The dashboard, tRPC API, static assets, and a separate health
endpoint use the dashboard port (default `8484`).

Every `/v1/*` request must include a non-empty
`x-claude-code-session-id` header and a `claude-cli/<version>` User-Agent whose
version exactly matches the bundled `@anthropic-ai/claude-code` dependency on
the server. Missing identities, non-Claude clients, and version mismatches are
rejected before authentication, body processing, or account selection. The
local Claude telemetry routes remain exempt. These checks are compatibility
gates, not authentication; enable proxy API-key enforcement when access control
is required.

The proxy synchronizes every identity slot observed in direct Claude Code
message traffic. The outbound OAuth token and `account_uuid` come from the
pinned account, `device_id`/`x-device-id` come from that account's `machineID`
in its Claude Code folder, and embedded `session_id` fields are rewritten to the
validated session header. There is no manual device override or client-device
fallback. Identity fields are rewritten only where the client sent them, so
count-token requests that omit body identity remain the same shape as direct
traffic. The validated User-Agent is forwarded unchanged.
Body rewrites are limited to the exact `device_id`, `account_uuid`, and
`session_id` members of the `metadata.user_id` JSON envelope; arbitrary
lookalike fields are never treated as identity slots.

The pinned account must have a real `accountUuid` in `.claude.json`; if it is
missing, cc-lb returns `503 account_identity_missing`. A request carrying a
device ID also requires an account-specific `machineID` in `.claude.json`,
otherwise it returns `503 account_device_identity_missing`. Both checks happen
before token or upstream work, and there is no internal-ID fallback.

Client device identity is accepted only in the `x-device-id` header or the
exact `device_id` member of the JSON envelope in `metadata.user_id`. The first
client value is persisted with the sticky session. A later conflicting client
device value fails closed. The original value may not occur in any other header
or body location—including conversation, system, tool, or duplicate JSON-key
content—or the request is rejected with `403 unexpected_device_identity`
instead of allowing an unrewritten device fingerprint to reach Anthropic.
Malformed JSON and duplicate object keys are also rejected before a session is
claimed or request traffic is sent upstream.

A previously unseen session is pinned to an account as `pending` when a quota
or count-token preflight establishes its binding. The first substantive
`/v1/messages` request must contain no top-level `role: "assistant"` message;
that request promotes the same permanent binding to `active`. Assistant history
while the session is unknown or still pending is rejected with
`403 unknown_session_history` and never reaches Anthropic. Active sessions may
contain normal assistant history.

The first eligible account selected for a session is claimed before its first
upstream request and remains that chat's permanent home, whether the binding is
pending or active. cc-lb never moves the session to another account after a
token error, 401, rate limit, overload, or network failure; the request fails
while its account is unavailable. An operator can permanently block either a
pending or active session from the Sticky dashboard. Blocking keeps a
tombstone, so that session ID is rejected and can never be reassigned. Deleting
an account atomically turns all of its linked chats into the same permanent
blocked tombstones.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_PORT` | `8484` | Dashboard, tRPC API, static assets, and dashboard health-check port. |
| `PROXY_PORT` | `8485` | Claude Code `/v1/*`, local telemetry, and proxy health-check port. Must differ from `DASHBOARD_PORT`. |
| `PORT` | unset | Deprecated dashboard-port fallback used only when `DASHBOARD_PORT` is unset. |
| `DB_PATH` | `./data/cc-lb.db` | SQLite database path. |
| `CLAUDE_CONFIG_DIR` | `./data/claude` | Default Claude config dir for CLI sessions. |
| `CLAUDE_ACCOUNTS_DIR` | `./data/claude-accounts` | Per-account Claude config directories. |
| `CLAUDE_CODE_LOGIN_COMMAND` | repo-local `claude` binary | Command run inside `tmux` for login and refresh. |
| `CLAUDE_CODE_TMUX_SOCKET` | `/tmp/cc-lb-claude-code.tmux` | Dedicated tmux socket path. |
| `DASHBOARD_PASSWORD` | unset | Protects the dashboard and `/api/trpc` when set. |
| `ANTHROPIC_API_BASE` | `https://api.anthropic.com` | Upstream Anthropic API base URL. |

Dashboard password auth does not protect the proxy port or `/v1/*`. Use the
dashboard's API-key setting when the proxy endpoint itself should reject
unknown clients.

## Security

Do not expose cc-lb directly to the public internet. At minimum, set
`DASHBOARD_PASSWORD`, enable proxy API-key auth, and keep it behind a private
network or trusted reverse proxy.

Protect `data/`. It contains:

- `cc-lb.db`
- per-account Claude Code config directories
- `.credentials.json` files with plaintext OAuth tokens
- optional debug/compare logs

Raw HTTP logging is useful for debugging but may capture prompts, responses,
headers, and other sensitive request content.

## Project Layout

```text
src/                 Bun server, tRPC API, proxy, persistence
frontend/            React dashboard source
public/              Built dashboard assets
tests/e2e/           Playwright smoke tests
docs/research/       Reference notes and implementation research
scripts/             Utility scripts
docker-compose.yml   Local Docker deployment
```

## Credits

The account/proxy behavior is informed by
[better-ccflare](https://github.com/tombii/better-ccflare), and the dashboard
direction and routing ideas are informed by
[codex-lb](https://github.com/Soju06/codex-lb).
