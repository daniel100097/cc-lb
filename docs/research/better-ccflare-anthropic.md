# better-ccflare — Anthropic Connection Handling

better-ccflare is a Bun/TypeScript monorepo. Everything specific to talking to Anthropic lives in three packages: `packages/oauth-flow` and `packages/providers/src/providers/anthropic` (credential acquisition/refresh), and `packages/proxy` (request forwarding, rate-limit handling, failover). This document traces the exact behavior, with file:line references and quoted constants.

---

## 1. OAuth flow: adding an account

### 1.1 Two modes

Accounts are added in one of two OAuth modes (`packages/oauth-flow/src/index.ts:11-14`):

- **`claude-oauth`** — standard OAuth for Claude CLI (Pro/Max) accounts. Stores refresh + access tokens, provider recorded as `"anthropic"`.
- **`console`** — OAuth flow that then mints a static API key. Provider recorded as `"claude-console-api"`.

The flow is a two-step `begin()` / `complete()` handshake. `OAuthFlow` itself does not persist session state; the HTTP-API caller stores `{sessionId, verifier, mode}` between the two calls (`packages/oauth-flow/src/index.ts:100-114`).

### 1.2 Authorization URL, scopes, redirect

Config comes from `AnthropicOAuthProvider.getOAuthConfig()` (`packages/providers/src/providers/anthropic/oauth.ts:25-48`):

```
authorizeUrl  = "https://console.anthropic.com/oauth/authorize"   (console mode)
              = "https://claude.ai/oauth/authorize"                (claude-oauth mode)
tokenUrl      = "https://platform.claude.com/v1/oauth/token"
redirectUri   = "https://platform.claude.com/oauth/code/callback"
scopes        = ["org:create_api_key", "user:profile", "user:inference",
                 "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"]
```

The `clientId` is left empty in the provider config and injected at runtime from `Config.getRuntime()` (`packages/oauth-flow/src/index.ts:93-95`). The default client ID (the public Claude Code OAuth client) is:

```
clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
```
(`packages/config/src/index.ts:581`; overridable via `CLIENT_ID` env var or `client_id` in the config file, lines 605-606 / 628-629.)

The authorize URL is built in `generateAuthUrl()` (`oauth.ts:50-65`). Note it sets `code=true` (Anthropic's flag that returns the authorization code in the browser for manual copy-paste) plus the standard OAuth params: `client_id`, `response_type=code`, `redirect_uri`, `scope` (space-joined), `code_challenge`, `code_challenge_method=S256`, and a `state` value.

### 1.3 PKCE

PKCE is generated in `packages/providers/src/oauth/pkce.ts:37-50`:

- Verifier: 32 random bytes (`crypto.getRandomValues`), base64url-encoded (no padding).
- Challenge: `SHA-256(verifier)`, base64url-encoded.
- Method: `S256` (RFC 7636).

The CSRF `state` is generated **separately** from the PKCE verifier — 32 random bytes hex-encoded (`oauth.ts:17-23`), explicitly to keep secrets out of the state parameter.

### 1.4 Token exchange

`AnthropicOAuthProvider.exchangeCode()` (`oauth.ts:67-166`):

- Anthropic returns the code as `code#state` (fragment-joined). The code is split on `#` — `splits[0]` is the actual code, `splits[1]` is the state (`oauth.ts:72-75`).
- Request is a **JSON POST** (not form-encoded) to `https://platform.claude.com/v1/oauth/token` with `Content-Type: application/json` and body `{code, state, grant_type:"authorization_code", client_id, redirect_uri, code_verifier}` (`oauth.ts:83-106`).
- Response parsed as `{refresh_token, access_token, expires_in}`; `expiresAt = Date.now() + expires_in*1000` (`oauth.ts:149-165`).

(Note: there is a generic `BaseOAuthProvider` in `packages/providers/src/oauth/base-oauth-provider.ts` that does form-encoded exchange, but Anthropic uses its own `AnthropicOAuthProvider` with JSON, so the base class is not on the Anthropic path.)

### 1.5 Console-mode API key creation

For `console` mode (or if no refresh token is returned), `complete()` calls `createAnthropicApiKey()` (`packages/oauth-flow/src/index.ts:225-248`), which POSTs the temporary access token to:

```
https://api.anthropic.com/api/oauth/claude_cli/create_api_key
  Authorization: Bearer <accessToken>
  Content-Type: application/x-www-form-urlencoded
```
and reads `raw_key` from the JSON response — a permanent API key stored in the `api_key` column.

### 1.6 Credential storage (schema/format)

Accounts live in the SQLite (or PostgreSQL) `accounts` table. Base schema (`packages/database/src/migrations.ts:110-127`):

```
id TEXT PK, name TEXT, provider TEXT DEFAULT 'anthropic',
api_key TEXT, refresh_token TEXT, access_token TEXT, expires_at INTEGER,
created_at INTEGER, last_used, request_count, total_requests,
priority INTEGER DEFAULT 0, consecutive_rate_limits INTEGER DEFAULT 0
```

Later migrations add: `rate_limited_until`, `session_start`, `session_request_count`, `rate_limit_reset`, `rate_limit_status`, `rate_limit_remaining`, `priority`, `custom_endpoint`, `refresh_token_issued_at`, `paused`, `pause_reason`, `auto_fallback_enabled`, `auto_pause_on_overage_enabled`, `rate_limited_at`, `rate_limited_reason`, and more (migrations.ts ~520-720).

Insert paths:
- OAuth account: `createAccountWithOAuth()` stores `provider='anthropic'`, `refresh_token`, `access_token`, `expires_at`, and `refresh_token_issued_at = Date.now()` (`oauth-flow/src/index.ts:274-317`). `api_key` is NULL.
- API-key account: `createAccountWithApiKey()` stores `provider='claude-console-api'`, `api_key`, with `refresh_token/access_token/expires_at` NULL (`oauth-flow/src/index.ts:333-373`).

**Re-authentication** (`completeReauth`, `oauth-flow/src/index.ts:180-230`) updates the existing row in place by `id`, preserving stats/priority: `UPDATE accounts SET refresh_token=?, access_token=?, expires_at=?, refresh_token_issued_at=Date.now() WHERE id=?`.

Tokens are stored in plaintext in the DB (the SQLite file at `~/.config/better-ccflare/better-ccflare.db`). When request headers are persisted for analytics, `authorization`, `x-api-key`, and `cookie` are stripped (`packages/http-common/src/headers.ts:26-37`).

---

## 2. Token refresh

### 2.1 When a refresh is triggered

`getValidAccessToken()` (`packages/proxy/src/handlers/token-manager.ts:499-555`) is called before every proxied request. Logic:

1. API-key providers (`openai-compatible`, `zai`, `claude-console-api`, `anthropic-compatible`, `minimax`) return `account.api_key` directly — no OAuth (lines 504-515).
2. If the token exists and `expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS`, return it as-is (lines 524-530).
3. Otherwise refresh via `refreshAccessTokenSafe()`.

`TOKEN_SAFETY_WINDOW_MS = 30 * 60 * 1000` (30 minutes) — proactive refresh window (`packages/proxy/src/constants.ts:11`). So tokens are refreshed when within 30 minutes of expiry.

### 2.2 The refresh request

`AnthropicProvider.refreshToken()` (`packages/providers/src/providers/anthropic/provider.ts:76-229`):

- **Console/API-key accounts** (`account.api_key` present): returns the API key with a synthetic 24-hour expiry and empty `refreshToken` (the empty string prevents a DB token update). Lines 89-108.
- **OAuth accounts**: JSON POST to the token endpoint (lines 128-142):

```
POST https://platform.claude.com/v1/oauth/token
Content-Type: application/json
{ grant_type: "refresh_token", refresh_token: <account.refresh_token>, client_id: <clientId> }
```

Response `{access_token, expires_in, refresh_token?}` → `{accessToken, expiresAt: Date.now()+expires_in*1000, refreshToken: json.refresh_token || account.refresh_token}` (lines 200-228). If Anthropic does **not** return a new refresh token, the previous one is kept (rotation-tolerant). 401 errors with messages like `invalid_grant`, `invalid_refresh_token`, or "OAuth authentication is currently not supported" are logged as needing re-authentication (lines 167-184).

### 2.3 Refresh serialization / locking (de-duplication)

`refreshAccessTokenSafe()` (`token-manager.ts:140-301`) serializes concurrent refreshes per account using an in-flight promise map on the proxy context (`ctx.refreshInFlight`, a `Map<accountId, Promise<string>>`):

- If a refresh for the account is already in flight, the caller awaits the existing promise (lines 231, 294-300) — only one HTTP refresh happens even under concurrent load.
- On success (lines 238-269): the DB update is enqueued asynchronously (`ctx.dbOps.updateAccountTokens`), and the **in-memory** `account` object is mutated immediately (`access_token`, `expires_at`, `refresh_token`, `last_used`) so concurrent requests don't see stale tokens. The failure record is cleared. The in-flight entry is deleted in `.finally()` (lines 286-289).

### 2.4 Failure backoff

On refresh failure (lines 270-285) the timestamp is recorded in a `refreshFailures` map. Subsequent refresh attempts within `TOKEN_REFRESH_BACKOFF_MS = 60_000` (60s, `constants.ts:18`) throw `ServiceUnavailableError` without hitting the network (lines 148-224). Backoff hits are counted; after `MAX_BACKOFF_RETRIES = 10` consecutive hits (line 27), the code reloads the account from the DB to pick up a token another process/pod may have refreshed (lines 160-220) — important for multi-pod PostgreSQL deployments. Failure records expire after `FAILURE_TTL_MS = 5 min` via a cleanup interval (lines 25, 32-58); the map is capped at `MAX_FAILURE_RECORDS = 1000`.

### 2.5 Refresh-token expiry / health

`checkRefreshTokenHealth()` and `isRefreshTokenLikelyExpired()` (`packages/proxy/src/handlers/token-health-monitor.ts:37-125`, `287-300`) estimate refresh-token age from `refresh_token_issued_at ?? created_at`, against thresholds in `constants.ts`:

```
REFRESH_TOKEN_WARNING_THRESHOLD_MS  = 7 days
REFRESH_TOKEN_CRITICAL_THRESHOLD_MS = 3 days
REFRESH_TOKEN_MAX_AGE_MS            = 90 days
```

`isRefreshTokenLikelyExpired` returns true when age > 90 days (or token/date missing). When all accounts fail, the proxy uses this to produce a "please re-authenticate" `ServiceUnavailableError` naming the affected accounts with ready-to-run `--reauthenticate` commands (`packages/proxy/src/proxy.ts:503-525`).

### 2.6 Auto-refresh scheduler (usage-window warming)

`packages/proxy/src/auto-refresh-scheduler.ts` periodically sends a synthetic "dummy" message to accounts whose usage window has reset, so a new 5-hour window starts promptly (README's "30-minute buffer" feature). These probes carry marker headers: `x-better-ccflare-account-id` (force-route), `x-better-ccflare-bypass-session: true` (skip session tracking), and `x-better-ccflare-auto-refresh: true` (exclude from dashboard metrics) — lines 388-397. It compares the stored vs. fresh `rate_limit_reset` to detect a new window (lines 197-213).

---

## 3. Request proxying to api.anthropic.com

### 3.1 Entry and orchestration

`handleProxy()` (`packages/proxy/src/proxy.ts:149-532`) is the top-level handler:

1. Short-circuits Claude Code internal endpoints `POST /api/event_logging/batch` and `/api/system/package-manager` with a synthetic `{"success":true}` 200 (lines 156-165).
2. Tracks the client version from `user-agent` (line 168) for auto-refresh model selection.
3. Buffers the entire request body once (`prepareRequestBody`, `request-handler.ts:48-65`) so it can be replayed across failover attempts.
4. Validates `/v1/messages` bodies — rejects requests without a `messages` array with a 400 `invalid_request_error` (lines 189-221), filtering out Claude Code internal telemetry events.
5. Optionally injects 1-hour cache TTL into system-prompt `cache_control` blocks (see §6).
6. Applies agent model interception, selects accounts, and iterates them calling `proxyWithAccount()`.

### 3.2 Target URL

`AnthropicProvider.buildUrl()` (`provider.ts:243-264`): default `https://api.anthropic.com`, concatenated as `${endpoint}${path}${query}`. If the account has a validated `custom_endpoint`, that base is used instead (enterprise deployments). The incoming path and query string are preserved verbatim.

### 3.3 Header rewriting

The Anthropic-specific `prepareHeaders()` (`provider.ts:266-305`) does the following on a copy of the client's headers:

- **Authorization stripping**: if the proxy has provider credentials (`accessToken` or `apiKey` defined), it deletes both incoming `authorization` and `x-api-key` (lines 277-280) to prevent client-credential leakage upstream. In pure passthrough mode (no credentials) the client's auth is preserved.
- **OAuth accounts**: sets `Authorization: Bearer <accessToken>` (line 284), and ensures the OAuth beta header is present — if `anthropic-beta` exists and lacks it, appends `,oauth-2025-04-20`; otherwise sets `anthropic-beta: oauth-2025-04-20` (lines 287-296). This is required for Claude Code OAuth traffic.
- **API-key accounts**: sets `x-api-key: <apiKey>` (lines 297-299).
- Deletes the `host` header (line 302).

Additionally, the generic `BaseProvider.prepareHeaders()` (`base.ts:37-66`) strips every `x-better-ccflare-*` internal header before forwarding — but note the Anthropic provider **overrides** `prepareHeaders` and does **not** call super, so it does not strip `x-better-ccflare-*` itself. Instead `proxyWithAccount` explicitly deletes the synthetic-response markers (`proxy-operations.ts:606-608`), and other internal markers are removed at the response-tagging stage. Client headers such as `anthropic-version`, `anthropic-beta`, `x-stainless-*`, `user-agent`, `content-type` are otherwise **passed through unchanged** to Anthropic (the proxy copies the client's header set rather than reconstructing it). `anthropic-version` presence is later used to decide whether to skip the OpenAI-compat stream transform (see §6).

### 3.4 Body handling and the request pipeline

Per-account, `proxyWithAccount()` (`proxy-operations.ts:498-1194`):

1. Applies any combo model override to the body (`withPatchedModel`, lines 529-550).
2. Stages the original body + headers in `cacheBodyStore` for cache-keepalive replay (lines 566-577), skipped for synthetic internal requests.
3. Gets a valid access token (`getValidAccessToken`), builds headers and target URL.
4. Builds a `Request` with the buffered body as a `Uint8Array` and `duplex: "half"` (lines 611-620).
5. Runs the provider's `transformRequestBody` (Anthropic: model-name mapping only — see §6).
6. Fires the request via `makeProxyRequest` (`request-handler.ts:76-129`), which uses Bun `fetch` with a `PROXY_REQUEST_TIMEOUT_MS = 30 minutes` timeout (`core/src/constants.ts:30`) to accommodate long agent calls.

### 3.5 Streaming (SSE) passthrough

Responses are streamed straight to the client. `forwardToClient()` (`packages/proxy/src/response-handler.ts:83-307`):

- Detects streaming via `isStreamingResponse` (content-type contains `text/event-stream` or `stream`, `base.ts:164-170`).
- For streaming responses, wraps the body in a `teeStream` (line 247) that forwards bytes to the client immediately while a tee copy feeds the async usage collector and a **mid-stream SSE rate-limit sniffer** (§4.4).
- Compression headers (`content-encoding`, `content-length`, `transfer-encoding`) are stripped before forwarding (`withSanitizedProxyHeaders`, `headers.ts:43-49`), because Bun already decompressed the body — leaving `content-encoding: gzip` would cause client "Decompression error: ZlibError".
- Non-streaming responses are also teed, with the body captured up to a 256 KB cap for analytics (lines 276-300).

The response also goes through `AnthropicProvider.processResponse()` (`provider.ts:554-573`) which sanitizes hop-by-hop headers and optionally applies the OpenAI finish_reason transform (§6).

---

## 4. Rate-limit handling

### 4.1 Header parsing

`AnthropicProvider.parseRateLimit()` (`provider.ts:307-435`) is the core parser. It reads Anthropic's **unified** rate-limit headers:

```
anthropic-ratelimit-unified-status     -> statusHeader
anthropic-ratelimit-unified-reset      -> resetHeader (unix seconds)
anthropic-ratelimit-unified-remaining  -> remaining
```

Hard-limit statuses that block the account (`provider.ts:14-19`):
```
HARD_LIMIT_STATUSES = { "rate_limited", "blocked", "queueing_hard", "payment_required" }
```
Soft statuses `allowed_warning`, `queueing_soft` do **not** block (lines 40-41).

Logic:
- An account is considered rate-limited if the status is a hard-limit status, **or** HTTP 429, **or** HTTP 529 (overloaded) — a 529 counts as an overload even if the unified-status header says "allowed" (lines 326-329).
- `resetTime = Number(resetHeader) * 1000` (ms) for non-529 cases (lines 347-356).
- For **529 (overloaded_error)**: tries `anthropic-ratelimit-unified-reset`, then `Retry-After` (delta-seconds or HTTP-date), then `x-ratelimit-reset` (unix seconds), all clamped via `clampResetTime` (lines 331-413).
- For **429** without unified headers: uses `x-ratelimit-reset` if present, else defaults to a `DEFAULT_429_COOLDOWN_MS = 60_000` (60s) cooldown (lines 415-434).

`clampResetTime()` (lines 33-38) rejects NaN/past/infinite values and caps any reset at `MAX_RESET_MS = 24h` from now — preventing a pathological `Retry-After` from benching an account for days.

### 4.2 Applying a cooldown (marking rate-limited/paused)

The single entry point is `applyRateLimitCooldown()` (`packages/proxy/src/handlers/rate-limit-cooldown.ts:26-77`):

- Computes exponential backoff: `computeRateLimitBackoffMs(consecutive+1)` where `backoff = BASE * 2^(n-1)` capped at MAX (`core/src/constants.ts:66-75`). Defaults: `RATE_LIMIT_BACKOFF_BASE_MS = 30s`, `RATE_LIMIT_BACKOFF_MAX_MS = 5min` (constants.ts:54-55), overridable via `CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS` / `_MAX_MS`.
- Final cooldown = `min(upstream resetTime, now + backoff)` when a reset is known, else `now + backoff` (lines 42-44).
- Mutates in-memory `account.rate_limited_until`, `rate_limited_at`, `consecutive_rate_limits` (lines 52-54), then enqueues the authoritative DB write `markAccountRateLimited(id, cooldownUntil, reason)` which returns the reconciled consecutive count (lines 56-69).

`RateLimitReason` audit values include `upstream_429_with_reset`, `upstream_429_no_reset_probe_cooldown`, `upstream_529_overloaded_with_reset`, `upstream_529_overloaded_no_reset`, `model_fallback_429`, `all_models_exhausted_429`, `out_of_credits`.

### 4.3 Response processing decision

`processProxyResponse()` (`packages/proxy/src/handlers/response-processor.ts:228-358`):

- Calls `parseRateLimit`. If rate-limited: applies cooldown (with reset if known, else probe cooldown) and returns `true` to signal failover (lines 280-312).
- On any **successful** response it clears `rate_limited_until` unconditionally (lines 342-354) — a success proves the account is usable (e.g. after a mid-window seat reset). It also resets the consecutive-429 streak counter once the account has been healthy for `RATE_LIMIT_RESET_STABILITY_MS = 5 min` (lines 327-336; `getRateLimitResetStabilityMs`).
- `updateAccountMetadata()` (lines 62-218) persists rate-limit metadata for **every** response carrying a `statusHeader`: `updateAccountRateLimitMeta(id, status, resetTime, remaining)` → `UPDATE accounts SET rate_limit_status=?, rate_limit_reset=?, rate_limit_remaining=?` (`account.repository.ts:153-163`). Thus `rate_limit_reset` continuously tracks the Anthropic usage-window reset time from the `unified-reset` header, even on 200s. This is what session/auto-fallback logic keys on (§4.5).

### 4.4 Mid-stream rate limits (SSE error frames)

Anthropic can emit a `rate_limit_error` / `overloaded_error` as an SSE `event: error` frame partway through a 200 stream. `createSseRateLimitSniffer()` (`packages/proxy/src/handlers/sse-rate-limit-sniffer.ts`) watches the outbound stream with a line-anchored regex requiring `event: error` followed within ≤500 bytes by `"type":"rate_limit_error"` (or `overloaded_error`, enabled only for `anthropic`/`claude-oauth` providers, lines 42-89). It fires once, over a bounded 16 KB rolling buffer. On fire, `forwardToClient` calls `applyRateLimitCooldown` with a probe cooldown (`response-handler.ts:204-220`). `api_error` is deliberately excluded (request-scoped, not quota).

### 4.5 5-hour session / usage-window tracking

The default strategy is `SessionStrategy` (`packages/load-balancer/src/strategies/index.ts:18-390`), constructed with `sessionDurationMs = ANTHROPIC_SESSION_DURATION_DEFAULT = 5 * 60 * 60 * 1000` (5 hours; `core/src/constants.ts:15`).

- Session state is `session_start` + `session_request_count` columns.
- `resetSessionIfExpired()` (index.ts:33-70) starts a new session when either the fixed 5-hour duration elapses **or** (Anthropic only) `rate_limit_reset < now - 1000` (the usage window reset, with a 1s clock-skew buffer).
- `hasActiveSession()` (lines 81-105) pins requests to an account whose `session_start` is within 5 hours **and** which is not currently rate-limited — preserving prompt-cache locality without funneling into a throttled account (issue #115).
- Only providers where `requiresSessionDurationTracking(provider)` is true (Anthropic OAuth) get sessions; API-key/pay-as-you-go providers do not.

There is also a `SessionAffinityStrategy` (client-`user_id`-keyed stickiness, same 5-hour default TTL) in `session-affinity.ts`, and usage-throttling based on 5-hour / weekly windows (`five_hour: 5*60*60*1000`, `packages/core/src/throttle-utils.ts:21`) applied in `proxy.ts:253-289`.

---

## 5. Account rotation / failover on errors

Failover is driven by `handleProxy()` iterating the ordered account list and calling `proxyWithAccount()`, which returns a `Response` on success or `null` to signal "try the next account" (`proxy.ts:406-450`).

### 5.1 Account ordering

`selectAccountsForRequest()` (`packages/proxy/src/handlers/account-selector.ts:69-247`):
- Honors a forced account via `x-better-ccflare-account-id` (lines 74-133).
- Honors `x-better-ccflare-exclude-providers` (e.g. Codex traffic excludes `anthropic-oauth`, lines 137-166).
- Combo-aware routing by model family (lines 168-244), else falls back to the strategy's `select()`.
- `isAccountAvailable()` (`core/src/strategy.ts:14-22`) = `!paused && (!rate_limited_until || rate_limited_until < now)`.

Priority is the primary sort key (lower number = higher priority); ties broken by utilization. Auto-fallback re-promotes higher-priority accounts once their window resets (`checkForAutoFallbackAccounts`, index.ts:355-389), and safe-reason paused accounts (`overage`, `rate_limit_window`, or no reason) are auto-unpaused; `manual`/`failure_threshold` pauses are never auto-unpaused.

### 5.2 Conditions that trigger failover (`return null`)

Within `proxyWithAccount`:

- **Upstream 401** (invalid/expired creds): `return null` to try the next account (lines 1032-1038, re-checked after 529 retries at 1114-1123).
- **429 with no model fallbacks**: applies cooldown (`model_fallback_429`) and fails over (lines 812-864). 429s are never forwarded to the client while other accounts remain.
- **All model fallbacks exhausted + 429**: cooldown (`all_models_exhausted_429`) and fail over (lines 947-1003).
- **`out_of_credits` 429**: model/beta-scoped, so the account is **not** benched — it fails over per-request but stays in rotation for other models (lines 764-803; `isAnthropicOutOfCredits` checks `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits`, `provider.ts:58-64`).
- **Rate-limited response** (via `processProxyResponse` returning true): `return null` (proxy-operations.ts:1130-1167). Exception: when `returnRateLimitedResponseOnExhaustion` is set (last account) and the status is 529, the final 529 is forwarded rather than a synthetic pool-exhausted error.
- **Thrown errors** (network, timeout): caught by `handleProxyError`, `return null` (lines 1190-1193).

### 5.3 In-place 529 retry before failover

For a reset-less 529, `proxyWithAccount` retries in place with full-jitter exponential backoff before cooling the account (lines 1044-1112), governed by `getOverloadRetryConfig()` (`core/src/constants.ts:97-113`): enabled by default, `maxAttempts=2`, `baseMs=750`, `maxMs=3000`, tunable via `CCFLARE_OVERLOAD_RETRY_*`. This avoids all accounts cooling simultaneously under a concurrency spike.

### 5.4 Pool exhaustion

If no account is available (all paused/rate-limited/throttled), the proxy returns a **503 `pool_exhausted`** response (`createPoolExhaustedResponse`, proxy-operations.ts:1202-1276) listing each account's reason and `available_at`, with a `Retry-After` header derived from the earliest `rate_limited_until`. Optionally (`CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1`) it falls back to unauthenticated passthrough. If all failed accounts have likely-expired refresh tokens, it throws a `ServiceUnavailableError` with `--reauthenticate` instructions instead (proxy.ts:503-525).

### 5.5 Keepalive burst suppression

Synthetic cache-keepalive replays (`x-better-ccflare-keepalive: true`) that get 429'd are **not** cooled down — a burst of parallel keepalive requests can trip Anthropic's per-IP limit and would otherwise drain the whole pool (proxy-operations.ts:820-827, 961-966; response-processor.ts:289-294). Auto-refresh probes get similar special handling.

---

## 6. Anthropic-specific quirks handled

**System-prompt project detection.** `extractProjectFromRequest()` (proxy.ts:76-102) reads the `system` prompt (string or array of text blocks) and infers a project name from a filesystem path regex or a leading `# Heading`, for dashboard grouping. This only reads the prompt; it does not modify it.

**System-prompt cache-TTL injection.** When `getSystemPromptCacheTtl1h()` is enabled, `injectSystemCacheTtl()` (proxy.ts:539-576) walks `body.system[]` and adds `cache_control.ttl = "1h"` to `ephemeral` blocks that lack a TTL, extending prompt-cache lifetime. This is the only system-prompt mutation.

**Model mapping.** `AnthropicProvider.transformRequestBody()` (provider.ts:231-241) applies `mapModelName(model, account)`. For a plain Anthropic account with no custom mappings, `getModelList` returns null and the model passes through unchanged (`mapModelName`, `model-mappings.ts:241-256`). Custom per-account model mappings/fallbacks (stored in `custom_endpoint` JSON or `model_fallbacks`) are honored, and on model-unavailable/429 the proxy cycles through the fallback list `[primary, ...fallbacks]` starting at index 1 (proxy-operations.ts:874-942). Model families are matched by substring `fable/opus/haiku/sonnet` (`KNOWN_PATTERNS`, model-mappings.ts:13-30).

**count_tokens.** `POST /v1/messages/count_tokens` is proxied straight to Anthropic like any other request. It is only special-cased (synthetic local estimate) for `openai-compatible` and `codex` providers (response-processor.ts:14-22, response-handler.ts:126-130); native Anthropic count_tokens is a normal upstream call.

**OpenAI-compat finish_reason transform.** For non-native clients (requests **without** an `anthropic-version` header), `transformStreamToOpenAIFormat()` (provider.ts:443-552) rewrites the SSE stream to add `finish_reason` alongside Anthropic's `stop_reason` on `message_delta` events (`end_turn→stop`, `max_tokens→length`, `tool_use→tool_calls`, etc.). Native Anthropic SDK clients (which always send `anthropic-version`) are passed through untouched (lines 447-450).

**Thinking-block signature errors.** When Anthropic returns a 400 like "Invalid `signature` in `thinking` block" or "final `assistant` message must start with a thinking block" (from cross-provider thinking blocks), `proxyWithAccount` filters thinking blocks out of the request and retries once (`filterThinkingBlocks`, `isInvalidThinkingSignatureError`, proxy-operations.ts:149-313, 666-704).

**cache_control rejection.** For upstreams that reject the `cache_control` field (strict OpenAI-compat validators), a 400 triggers a one-time retry with `cache_control` stripped, and the `(accountId, model)` pair is remembered so future requests pre-strip (proxy-operations.ts:319-350, 706-734).

**Tier detection.** `extractTierInfo()` (provider.ts:575-597) reads `usage.rate_limit_tokens` from responses to classify accounts as tier 1/5/20 (≥800k→20, ≥200k→5, else 1).

**Usage/cost extraction.** `extractUsageInfo()` (provider.ts:599-804) parses `message_start` SSE events (bounded to `ANTHROPIC_STREAM_CAP_BYTES = 32 KB` with a 10s read timeout) and non-streaming JSON for `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and reads cost from the `anthropic-billing-cost` response header.

---

## Key constants and endpoints (quick reference)

| Item | Value | Location |
|---|---|---|
| OAuth client ID (default) | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | config/src/index.ts:581 |
| Authorize URL (Pro/Max) | `https://claude.ai/oauth/authorize` | providers/anthropic/oauth.ts:31,34 |
| Authorize URL (console) | `https://console.anthropic.com/oauth/authorize` | oauth.ts:29,34 |
| Token URL (exchange + refresh) | `https://platform.claude.com/v1/oauth/token` | oauth.ts:35; provider.ts:136 |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` | oauth.ts:45 |
| API-key creation | `https://api.anthropic.com/api/oauth/claude_cli/create_api_key` | oauth-flow/src/index.ts:226 |
| Default API base | `https://api.anthropic.com` | provider.ts:244 |
| OAuth scopes | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` | oauth.ts:37-44 |
| OAuth beta header | `anthropic-beta: oauth-2025-04-20` | provider.ts:290-295 |
| PKCE method | `S256`, 32-byte verifier | oauth/pkce.ts:37-50 |
| Token proactive-refresh window | 30 min (`TOKEN_SAFETY_WINDOW_MS`) | proxy/src/constants.ts:11 |
| Refresh failure backoff | 60 s (`TOKEN_REFRESH_BACKOFF_MS`) | proxy/src/constants.ts:18 |
| Refresh-token max age | 90 days | proxy/src/constants.ts:62 |
| Anthropic session window | 5 h (`ANTHROPIC_SESSION_DURATION_DEFAULT`) | core/src/constants.ts:15 |
| 429 no-reset default cooldown | 60 s (`DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS`) | core/src/constants.ts:48 |
| 429 backoff | base 30 s, cap 5 min, `BASE*2^(n-1)` | core/src/constants.ts:54-55,66 |
| Max cooldown clamp | 24 h (`MAX_RESET_MS`) | provider.ts:24 |
| Upstream request timeout | 30 min (`PROXY_REQUEST_TIMEOUT_MS`) | core/src/constants.ts:30 |
| Unified rate-limit headers | `anthropic-ratelimit-unified-{status,reset,remaining}`, `...-overage-disabled-reason` | provider.ts:309-317, 61-62 |
