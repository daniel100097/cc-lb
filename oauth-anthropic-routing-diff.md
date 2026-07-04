# OAuth Anthropic Request Routing Diff

Scope: only the OAuth-authenticated path for routing client requests to the Anthropic API, including account selection, token use, upstream URL construction, request/header/body mutations, response handling, and failover behavior.

Compared:

- Current project: `/home/daniel/projects/cc-lb`
- Reference: `reference/better-ccflare`

## Short Version

Current `cc-lb` is a direct Anthropic OAuth proxy:

1. Select an available OAuth account.
2. Refresh its access token if needed.
3. Forward the original request body unchanged to `API_BASE + original path/query`.
4. Strip client auth headers.
5. Inject `Authorization: Bearer <oauth access token>`.
6. Ensure `anthropic-beta: oauth-2025-04-20`.
7. Strip decompression-sensitive response headers before returning to the client.

`better-ccflare` routes through a provider abstraction:

1. Select provider-compatible accounts.
2. Get an access token or use an API key depending on account/provider type.
3. Build a default or per-account custom upstream URL.
4. Rewrite auth headers depending on OAuth vs API-key mode.
5. Optionally transform the request body, especially model mapping.
6. Retry with modified request bodies for specific Anthropic/provider failures.
7. Process the response through the provider before forwarding and analytics.

The largest practical difference: current does not modify request bodies before Anthropic; reference can modify body `model`, strip `cache_control`, filter thinking blocks, and retry with fallback models.

## Request Routing Table

| Area | Current project | `reference/better-ccflare` | Difference/Risk |
|---|---|---|---|
| Proxy entry point | `handleProxy()` receives proxy traffic in `src/proxy/handler.ts:20`. Telemetry paths `/api/event_logging/batch` and `/api/system/package-manager` are answered locally at `src/proxy/handler.ts:17-33`. | `proxy()` validates provider/path, handles internal endpoints, selects accounts, then calls `proxyWithAccount()` in `reference/better-ccflare/packages/proxy/src/proxy.ts` and `proxy-operations.ts`. | Current is a smaller Anthropic-only proxy. Reference has a provider framework and more internal/synthetic paths. |
| Body buffering | Buffers request body once as `ArrayBuffer` in `src/proxy/handler.ts:38-47` so it can be replayed across failover attempts. | Buffers body through `RequestBodyContext`/body buffers and can create body streams for retries/replays in `reference/better-ccflare/packages/proxy/src/proxy.ts` and `proxy-operations.ts:524-550`. | Both buffer for retry/failover. Reference uses a richer body context because it may mutate JSON. |
| Body parsing purpose | Parses JSON only to derive `model` for logs and sticky-session key in `src/proxy/handler.ts:40-51`. | Parses body for model selection, combo routing, request metadata, model overrides, provider transforms, cache-control rewrites, fallback models, and analytics. | Current parsing is observational. Reference parsing can affect routing and the final upstream body. |
| Account selection | Loads all local accounts with `listAccounts()`, derives sticky key, orders candidates with sticky pin then strategy in `src/proxy/handler.ts:49-89` and `:253-294`. | Selects provider-compatible accounts, applies usage throttling, combo routing, strategy fallback, and provider filtering in `reference/better-ccflare/packages/proxy/src/proxy.ts:253-393`. | Current assumes all accounts are Anthropic OAuth. Reference supports mixed providers and more routing policies. |
| Availability checks | Current availability comes from account state: paused, `needs_reauth`, rate-limit cooldown, refresh-token health, etc. Account ordering filters via `isAvailable()` in `src/proxy/handler.ts:262-264`. | Reference filters by provider, cooldown, usage throttling, account state, combo route, and provider-specific behavior. | Reference has more ways to exclude or prioritize accounts. Current is simpler and easier to reason about. |
| Sticky/session routing | Current derives sticky key from request headers/body and pins a conversation to one account when enabled in `src/proxy/handler.ts:51-53`, `:76-85`. | Reference has strategy/combo/session routing plus staged body cache and keepalive replay paths. | Current sticky behavior is direct. Reference can alter account choice based on more operational state. |
| Token acquisition | `attempt()` calls `getValidAccessToken(account)` before every upstream request in `src/proxy/handler.ts:105-122`. | `proxyWithAccount()` calls `getValidAccessToken(account, ctx)` unless the request is a synthetic provider response path in `proxy-operations.ts:585-593`. | Current always needs OAuth access tokens. Reference can skip or vary token use for provider-specific synthetic/API-key paths. |
| Token refresh | `getValidAccessToken()` returns existing `access_token` if outside the safety window; otherwise refreshes with OAuth refresh token and updates DB in `src/anthropic/token-manager.ts:11-76`. | Reference token manager delegates refresh to the account provider. Anthropic provider can refresh OAuth accounts or return API keys for console/API-key accounts in `reference/better-ccflare/packages/providers/src/providers/anthropic/provider.ts:76-229`. | Current supports only OAuth refresh-token accounts. Reference supports OAuth and API-key style accounts. |
| Refresh failure handling | On refresh failure, current logs `token_error` and fails over to the next account in `src/proxy/handler.ts:106-122`. Fatal refresh errors set `needs_reauth` in `src/anthropic/token-manager.ts:62-68`. | Reference wraps/provider-classifies refresh failures, has richer backoff/recovery, and can later emit reauth command guidance when all OAuth accounts fail. | Current failure mode is compact and explicit. Reference is more operationally verbose. |
| Upstream URL construction | Target URL is always `${API_BASE}${url.pathname}${url.search}` in `src/proxy/handler.ts:124`; `API_BASE` defaults to `https://api.anthropic.com` in `src/anthropic/constants.ts:7`. | Anthropic provider uses `buildUrl(path, query, account)` and chooses per-account `custom_endpoint` if valid, otherwise `https://api.anthropic.com`, in `reference/better-ccflare/packages/providers/src/providers/anthropic/provider.ts:243-264`. | Current has one global upstream base. Reference can route different accounts to different Anthropic-compatible endpoints. |
| Request auth headers | Current copies incoming headers, deletes `authorization` and `x-api-key`, then sets `authorization: Bearer <accessToken>` in `src/anthropic/headers.ts:7-15`. | Reference deletes client auth only when provider credentials are present, then sets either `Authorization: Bearer <accessToken>` or `x-api-key: <apiKey>` in `reference/better-ccflare/packages/providers/src/providers/anthropic/provider.ts:266-305`. | Current always overwrites client credentials with OAuth bearer. Reference supports OAuth bearer, API-key accounts, and passthrough mode when no provider credentials are provided. |
| OAuth beta header | Current ensures exact `oauth-2025-04-20` exists in `anthropic-beta`, comma-appending if needed, in `src/anthropic/headers.ts:16-24`. | Reference adds `oauth-2025-04-20` only when using an access token; it does not add the OAuth beta header for API-key mode in `provider.ts:282-299`. | Current always treats proxied Anthropic traffic as OAuth. Reference distinguishes OAuth bearer vs API-key auth. |
| Hop-by-hop request headers | Current deletes `host` and `content-length` before fetch in `src/anthropic/headers.ts:26-29`. | Reference deletes `host` in provider headers; request handler/caller controls body stream and fetch request construction. | Both remove `host`. Current explicitly removes `content-length`; reference commonly reconstructs the `Request`, which lets runtime compute body length. |
| Request body mutation: normal path | Current forwards the original `bodyBuf` unchanged in fetch at `src/proxy/handler.ts:134-138`. | Reference calls provider `transformRequestBody()` after creating the provider request in `proxy-operations.ts:620-624`; Anthropic provider maps the JSON `model` field via account model mappings in `provider.ts:231-240` and `utils/model-mapping.ts:99-143`. | Current does not modify the JSON body. Reference can rewrite `model` before upstream. |
| Request body mutation: combo/model override | Not implemented in current proxy path. | Reference can patch body `model` from combo slot overrides before provider transform in `proxy-operations.ts:524-550`. | Reference can intentionally send a different model than the client requested. Current cannot. |
| Request body mutation: cache control | Current does not strip or alter `cache_control` fields. | Reference can pre-strip `cache_control` for known rejector `(account, model)` pairs, and retry without cache control on provider rejection, in `proxy-operations.ts:626-656` and `:706-734`. | Reference mutates body to work around provider incompatibility. Current forwards the client's body as-is and would surface upstream errors. |
| Request body mutation: thinking blocks | Current does not inspect or remove thinking blocks. | Reference detects invalid thinking-block signature errors and retries after filtering thinking blocks from the request body in `proxy-operations.ts:666-704`. | Reference may remove parts of the client's message and retry. Current does not. |
| Request body mutation: model fallback | Current fails over accounts on rate limit or upstream errors, but does not change the requested model. | Reference can cycle through account model fallback lists, patching the request body model and retrying on model-unavailable/rate-limited responses in `proxy-operations.ts:736-942`. | Reference may route one client request to a different model. Current preserves the requested model. |
| Internal request markers | Current has no equivalent internal synthetic request markers in the Anthropic path. | Reference strips internal synthetic-response headers before provider transformation in `proxy-operations.ts:605-608` and skips staging for keepalive/auto-refresh markers in `:566-577`. | Reference has internal proxy control headers that affect routing/replay. Current path is simpler. |
| Actual upstream fetch | Current calls `fetch(target, { method, headers, body, signal: AbortSignal.timeout(...) })` in `src/proxy/handler.ts:132-139`. | Reference builds a `Request`, runs provider transforms, then calls `makeProxyRequest(transformedRequest)` in `proxy-operations.ts:620-664`; request handler applies a cookie jar for some providers before fetch in `request-handler.ts:99-111`. | Current directly fetches Anthropic. Reference has a wrapper layer for provider-specific fetch behavior. |
| 401 handling | Current marks `needs_reauth`, logs `unauthorized`, discards body, and fails over to next account in `src/proxy/handler.ts:168-186`. | Reference treats upstream 401 as credential failure and returns `null` to fail over in `proxy-operations.ts:1032-1038` and again after 529 retry at `:1114-1123`. | Both fail over on 401. Current persists `needs_reauth` immediately in this path; reference's shown path mainly fails over and relies on other token health/refresh logic. |
| 429/529 rate limit handling | Current parses Anthropic unified headers, `retry-after`, `x-ratelimit-reset`; applies cooldown and fails over in `src/proxy/rate-limit.ts:21-55` and `src/proxy/handler.ts:188-206`. It retries reset-less 529 overloads in-place before failing over in `src/proxy/handler.ts:144-149`. | Reference provider parses richer Anthropic rate-limit cases and proxy logic handles out-of-credits, keepalive exceptions, model fallback retries, 529 jitter retries, and final forwarding options in `provider.ts:307+` and `proxy-operations.ts:736-1167`. | Current has direct account-level cooldown/failover. Reference distinguishes model/beta-scoped failures and may retry with modified body before account failover. |
| Success response handling | Current clears rate limit, logs request, strips response `content-encoding`, `content-length`, and `transfer-encoding`, tees response body for background usage capture, and returns original upstream stream in `src/proxy/handler.ts:208-250`. | Reference injects internal response metadata headers, calls `provider.processResponse()`, then `forwardToClient()`; Anthropic provider sanitizes proxy headers and transforms stream to OpenAI-compatible finish reason metadata in `provider.ts:554-572`, then response handler strips compression headers and sends analytics in `response-handler.ts:83-170`. | Both strip decompression-sensitive headers. Reference can transform response stream shape/metadata and does much richer analytics. |
| Response header sanitization | Current deletes `content-encoding`, `content-length`, `transfer-encoding` in `src/anthropic/headers.ts:37-42`. | Reference deletes the same headers via `sanitizeProxyHeaders()` in `reference/better-ccflare/packages/http-common/src/headers.ts:7-15`. | Functionally aligned for decompression safety. |
| Request/response analytics payload | Current logs request metadata and extracts usage from response body; it does not persist original request headers/body in the inspected path. | Reference `forwardToClient()` sanitizes request headers before persistence and can store capped request body payloads for analytics in `response-handler.ts:105-170`; `sanitizeRequestHeaders()` removes auth/cookie headers in `http-common/src/headers.ts:18-37`. | Reference has a larger analytics surface and explicit sensitive-header stripping. Current stores less request payload detail. |
| Empty pool behavior | Current returns `503 pool_exhausted` with account reasons in `src/proxy/handler.ts:396-410`. | Reference returns pool exhausted by default, but can pass through unauthenticated to upstream if `CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1` in `proxy.ts:297-310`; passthrough preserves client auth because provider credentials are undefined in `proxy-operations.ts:425-453`. | Current never passthroughs without a managed account. Reference has a compatibility escape hatch that can send the client's own credentials upstream. |

## Exact Current Request Mutation

For a normal OAuth-backed request in current `cc-lb`, the outbound Anthropic request is:

```text
URL:     (process.env.ANTHROPIC_API_BASE || "https://api.anthropic.com") + original pathname + original query
Method:  original method
Body:    original body bytes, unchanged
Headers:
  copied from client request
  delete authorization
  delete x-api-key
  set authorization = "Bearer <selected account OAuth access token>"
  ensure anthropic-beta includes "oauth-2025-04-20"
  delete host
  delete content-length
```

Current response mutation:

```text
Status/statusText: original upstream values
Body:              original upstream body stream
Headers:
  copied from upstream response
  delete content-encoding
  delete content-length
  delete transfer-encoding
```

Current does not change the request JSON body, requested model, messages, thinking blocks, tools, cache_control fields, or endpoint per account.

## Exact Reference Request Mutation For Anthropic OAuth Accounts

For a normal Anthropic OAuth account in `better-ccflare`, the outbound request can be:

```text
URL:
  account.custom_endpoint + original pathname + original query
  or "https://api.anthropic.com" + original pathname + original query

Method:
  original method

Headers:
  copied from client request
  delete authorization and x-api-key if provider credentials are present
  set Authorization = "Bearer <provider access token>" for OAuth accounts
  append anthropic-beta = "oauth-2025-04-20" for OAuth bearer mode
  delete host

Body:
  starts from original body
  may patch model for combo slot override
  may map model through account model_mappings
  may strip cache_control for known rejectors or retry without it
  may remove thinking blocks and retry after invalid signature errors
  may patch model to fallback models after model unavailable/rate-limit responses
```

For Anthropic console/API-key accounts, reference can instead set:

```text
x-api-key: <account api_key>
```

and it does not add the OAuth beta header in that branch.

## Practical Implications

1. Current is safer if the requirement is "send exactly what the client sent, only swapping credentials."
2. Reference is more capable if the requirement is "route intelligently across mixed providers/accounts and recover from provider-specific failures."
3. Current has fewer surprising body mutations: no model remapping, no cache-control stripping, no thinking-block filtering.
4. Reference can make a successful request by changing the model/body after failures; this improves availability but makes upstream behavior less transparent.
5. Current should add explicit API-key/proxy auth before public exposure because `/v1/*` is unauthenticated at the app layer.
6. If current adopts reference-style model mapping or custom endpoints, those should be tracked as visible routing decisions in request logs because they change what Anthropic actually receives.
