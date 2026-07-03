# 02 — Accounts & Auth

Everything Anthropic-connection here is lifted from
[better-ccflare research](../docs/research/better-ccflare-anthropic.md). Constants copied verbatim so our OAuth interops with real Claude Code accounts.

## Constants (`src/anthropic/constants.ts`)

```ts
export const CLIENT_ID   = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // public Claude Code OAuth client
export const AUTH_URL    = "https://claude.ai/oauth/authorize";     // Pro/Max
export const TOKEN_URL   = "https://platform.claude.com/v1/oauth/token"; // exchange + refresh
export const REDIRECT_URI= "https://platform.claude.com/oauth/code/callback";
export const API_BASE    = "https://api.anthropic.com";
export const SCOPES = [
  "org:create_api_key","user:profile","user:inference",
  "user:sessions:claude_code","user:mcp_servers","user:file_upload",
].join(" ");
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";                 // anthropic-beta value
export const TOKEN_SAFETY_WINDOW_MS = 30 * 60 * 1000;               // proactive refresh
```

## Account schema (`accounts` table)

```sql
CREATE TABLE accounts (
  id                     TEXT PRIMARY KEY,      -- uuid
  name                   TEXT NOT NULL,
  access_token           TEXT,
  refresh_token          TEXT,
  expires_at             INTEGER,               -- ms epoch
  refresh_token_issued_at INTEGER,
  scopes                 TEXT,
  created_at             INTEGER NOT NULL,
  last_used              INTEGER,
  -- balancing / usage
  priority               INTEGER NOT NULL DEFAULT 0,
  request_count          INTEGER NOT NULL DEFAULT 0,
  session_start          INTEGER,
  session_request_count  INTEGER NOT NULL DEFAULT 0,
  -- rate-limit state (from anthropic-ratelimit-unified-*)
  rate_limit_status      TEXT,
  rate_limit_reset       INTEGER,               -- ms epoch, usage-window reset
  rate_limit_remaining   INTEGER,
  rate_limited_until     INTEGER,               -- cooldown; NULL = available
  consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
  -- operator
  paused                 INTEGER NOT NULL DEFAULT 0,
  pause_reason           TEXT
);
```

## Adding accounts — two paths

### Path A: import credentials JSON

Claude Code stores creds at `~/.claude/.credentials.json`:

```json
{ "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1750000000000,
    "scopes": ["user:inference","user:profile"]
} }
```

`POST /api/accounts/import` accepts either that whole object or the inner `claudeAiOauth`. Server maps:
`access_token←accessToken`, `refresh_token←refreshToken`, `expires_at←expiresAt` (already ms), `scopes←scopes.join(' ')`, `refresh_token_issued_at←now`. Insert row. If `expires_at` is past, a refresh is triggered on first use.

### Path B: direct OAuth from dashboard

Two-step, mirrors better-ccflare `begin()`/`complete()`:

**`POST /api/accounts/oauth/begin`**
1. Generate PKCE (`src/anthropic/oauth.ts`): `verifier` = base64url(32 random bytes); `challenge` = base64url(SHA-256(verifier)); method `S256`.
2. Generate `state` = hex(32 random bytes) — **separate** from verifier.
3. Build authorize URL with params: `code=true`, `client_id`, `response_type=code`, `redirect_uri`, `scope=SCOPES`, `code_challenge`, `code_challenge_method=S256`, `state`.
4. Store `{sessionId, verifier, state}` in an in-memory Map (TTL 10 min). Return `{ authUrl, sessionId }`.

Dashboard opens `authUrl`; Anthropic shows a code the user copies (format `code#state`).

**`POST /api/accounts/oauth/complete`** `{ sessionId, code }`
1. Look up session → verifier. Split `code` on `#` → `[authCode, returnedState]`.
2. JSON POST to `TOKEN_URL`:
   ```json
   { "grant_type":"authorization_code", "code":"<authCode>", "state":"<returnedState>",
     "client_id":CLIENT_ID, "redirect_uri":REDIRECT_URI, "code_verifier":"<verifier>" }
   ```
   Header `Content-Type: application/json`.
3. Response `{access_token, refresh_token, expires_in}` → insert account, `expires_at = now + expires_in*1000`, `refresh_token_issued_at = now`. Fetch a display name (email) if available, else user-supplied.

## Token refresh (`src/anthropic/oauth.ts` + proxy)

`getValidAccessToken(account)` before each proxied request:
1. If `expires_at - now > TOKEN_SAFETY_WINDOW_MS` → return current `access_token`.
2. Else `refreshAccessTokenSafe(account)`:
   - **Dedup**: module-level `Map<accountId, Promise<string>>`. Concurrent callers await the same in-flight refresh.
   - JSON POST `TOKEN_URL`: `{ grant_type:"refresh_token", refresh_token, client_id:CLIENT_ID }`.
   - On success: `access_token←json.access_token`, `expires_at←now+expires_in*1000`, `refresh_token←json.refresh_token || old` (rotation-tolerant). Persist + mutate in-memory object. Clear failure record.
   - On failure: record timestamp; within `TOKEN_REFRESH_BACKOFF_MS=60s` throw without hitting network. 401 `invalid_grant`/`invalid_refresh_token` → flag account needs re-auth (surface in dashboard).

## Request header rewriting (`src/anthropic/headers.ts`)

On the copied client headers, per better-ccflare `prepareHeaders`:
- Delete incoming `authorization` and `x-api-key`.
- Set `Authorization: Bearer <accessToken>`.
- Ensure `anthropic-beta` contains `oauth-2025-04-20` (append if header exists without it, else set it).
- Delete `host`.
- Pass through `anthropic-version`, `anthropic-beta` (rest), `content-type`, `user-agent`, `x-stainless-*` unchanged.

Response headers: strip `content-encoding`, `content-length`, `transfer-encoding` before forwarding (Bun already decompressed — otherwise client hits ZlibError).

## Security notes

- Tokens stored plaintext in SQLite (same as both references). Document that `data/` must be protected; it is the secret store.
- Optional `DASHBOARD_PASSWORD` gates `/api/*` and the SPA with a simple bearer/cookie — the proxy `/v1/*` path is unauthenticated by default (bind to localhost or a private network). Make this explicit in README.
- Never log `authorization`/`refresh_token`/`x-api-key`; strip them from any request logging.
