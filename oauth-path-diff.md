# OAuth Implementation Diff

Compared current project (`/home/daniel/projects/cc-lb`) with the local reference tree `reference/better-ccflare`.

The requested `references/ccflare` path does not exist in this workspace; the available reference is `reference/better-ccflare`.

## Main Diffs

| Area | Current project | `reference/better-ccflare` | Difference/Risk |
|---|---|---|---|
| OAuth API surface | tRPC mutations under `/api/trpc`: `accounts.oauthBegin`, `oauthComplete`, `oauthReauthBegin`, `oauthReauthComplete` in `src/api/router.ts:126-193`. | REST endpoints: `/api/oauth/init`, `/api/oauth/callback`, `/api/oauth/anthropic/reauth/init`, `/api/oauth/anthropic/reauth/callback`, plus Qwen/Codex OAuth routes in `reference/better-ccflare/packages/http-api/src/router.ts:298-318`. | API contract is incompatible. Reference clients expecting REST OAuth will not work against current tRPC-only flow. |
| OAuth route auth | `/api/trpc` is dashboard-auth gated when `DASHBOARD_PASSWORD` is set in `src/index.ts:37-39`. | `/api/oauth*` is auth-exempt in `reference/better-ccflare/packages/http-api/src/services/auth-service.ts:139-142`. | Current protects OAuth setup behind dashboard auth; reference exposes OAuth endpoints publicly even when API-key auth is enabled. |
| Proxy auth | `/v1/*` bypasses dashboard auth in `src/index.ts:42-44`. | Proxy routes require API-key auth when keys exist in `reference/better-ccflare/packages/http-api/src/services/auth-service.ts:185-187`. | Current is risky if exposed publicly; reference has built-in API-key/RBAC protection. |
| Dashboard auth storage | Deterministic `cc_lb_session` HMAC cookie, `HttpOnly; SameSite=Lax`, no `Secure`, in `src/auth.ts:15-16` and `:97-99`. | API key stored in browser `localStorage` and sent as `x-api-key`. | Current avoids localStorage exposure but cookie is deterministic and not per-login random. Reference supports revocable keys/roles but stores a bearer secret in JS-accessible storage. |
| Begin flow | `beginOAuth()` generates PKCE/state/session and persists session directly in `src/anthropic/oauth.ts:39-65`. | `OAuthFlow.begin()` returns flow data; HTTP handlers validate and persist sessions separately. | Current is simpler and tightly coupled to DB. Reference is more extensible and validates more inputs. |
| Account input validation | Optional `name`, priority 0-10000, no duplicate-name check in `src/api/router.ts:69-82`. | Required/pattern-validated name, duplicate names rejected, priority 0-100. | Current can create duplicate/default-named accounts. |
| Provider modes | Claude OAuth/import only. | Anthropic `claude-oauth`, `console`, deprecated `max`, plus Qwen/Codex flows. | Current cannot create Console/API-key accounts or other provider OAuth accounts. |
| Console API-key flow | Not implemented. | Console mode exchanges OAuth access token for an Anthropic API key in `reference/better-ccflare/packages/oauth-flow/src/index.ts:245-264`. | Current requires OAuth refresh tokens; reference can store static API-key accounts. |
| Redirect URI/scopes/PKCE | Same Claude redirect URI and scope set; PKCE uses Node crypto. | Same redirect URI and scopes; PKCE uses Web Crypto. | Functionally equivalent for Claude OAuth. |
| State/CSRF | Stores generated `state` in DB and verifies exact returned state before exchange in `src/anthropic/oauth.ts:42-47` and `:121-125`. | Generates `state` into auth URL, but session storage keeps account name/verifier/mode/custom endpoint/priority, not state. | Current has stronger server-side CSRF binding. Reference cannot locally compare returned state to expected state in the inspected path. |
| Code parsing | Requires exactly non-empty `code#state`; rejects missing/extra `#` in `src/anthropic/oauth.ts:111-125`. | Splits on `#` and accepts missing/empty/extra fragments. | Current is stricter and safer for Claude pasted callback format; reference is more permissive/backcompat-friendly. |
| Token exchange errors | Throws raw status plus full upstream response text in `src/anthropic/oauth.ts:139-140`. | Parses structured JSON and throws `OAuthError`. | Reference has cleaner errors; current may expose raw upstream response body. |
| Session ID | 16 random bytes hex; input only checks non-empty string. | `crypto.randomUUID()` with UUID pattern validation. | Both are high entropy; reference rejects malformed session IDs earlier. |
| Session schema | Stores `id`, `verifier`, `state`, optional `account_id`, `name`, `priority`, timestamps in `src/db/schema.ts:67-80`. | Stores `account_name`, `verifier`, `mode`, `custom_endpoint`, `priority`, timestamps. | Current stores state and account-ID binding data. Reference stores provider-mode routing data. |
| Session cleanup | Cleanup runs opportunistically on create/read. | Repository cleanup plus startup/hourly cleanup. | Reference prunes expired sessions more actively. |
| Completion atomicity | Account create/update and session delete happen in one SQLite transaction in `src/api/router.ts:139-151` and `:176-190`. | Account write completes, then session delete is called afterward; async session helper calls are not awaited in inspected handlers. | Current has clearer ordering and lower reusable-session-after-write risk. |
| Reauth target binding | Reauth session stores `accountId` and verifies target match in `src/api/router.ts:155-175`. | Reauth stores account name, then callback looks up by name. | Current is safer against rename/delete/recreate/name-collision races. |
| Reauth updates | Updates tokens and clears `needs_reauth`, rate-limit cooldown, and consecutive limits in `src/api/router.ts:176-186`. | OAuth reauth updates token fields only; console reauth updates API key. | Current makes the account eligible immediately but may clear unrelated cooldown state. Reference preserves more state and supports console reauth. |
| Refresh behavior | Direct refresh, keeps old refresh token if omitted, sets `needs_reauth` on fatal grant errors. | Provider abstraction supports OAuth/API-key accounts and richer refresh backoff/recovery. | Current is easier to audit; reference is more robust for multi-provider/large-pool deployments. |
| Account storage | OAuth token fields only; no `provider`, `api_key`, or per-account endpoint in `src/db/schema.ts:3-25`. | Accounts include `provider`, `api_key`, OAuth tokens, `custom_endpoint`, etc. | Current is Anthropic-OAuth-only. Reference supports mixed provider/API-key pools. |
| Header rewrite | Always strips client auth, injects OAuth bearer and beta header. | Supports bearer OAuth or `x-api-key`; strips only when provider credentials exist. | Current cannot passthrough or use API-key accounts. Reference supports more auth modes. |
| Custom endpoint | Global `ANTHROPIC_API_BASE` only. | Per-account `customEndpoint` captured during OAuth and used by provider URL builder. | Current cannot mix endpoints per account. |
| Frontend add flow | Single dialog: credentials JSON or OAuth tab; paste `code#state`. | Multi-provider form with mode selector, custom endpoint, priority, and REST callbacks. | Current UX is narrower but simpler. |
| Frontend reauth | Per-account modal uses account ID and `code#state`. | Dedicated Anthropic reauth dialog uses REST init/callback and later resolves by account name. | Same manual-code UX; current backend target binding is stronger. |
| Frontend popup safety | Current opens OAuth URLs with explicit `noopener,noreferrer`. | One reference add-flow path was reported as plain `window.open(authUrl, "_blank")`. | Current is safer against opener access for that flow. |
| Sensitive logging | Current OAuth/refresh path does not log token bodies in inspected files. | Reference debug path logs refresh-token preview/request context. | Reference diagnostics have higher secret-exposure risk if debug logs are collected. |
| Server/browser hardening | Current static/login responses do not add CSP/frame/security headers. | Reference dashboard serving adds CSP, `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`. | Reference has stronger browser hardening. |
| Environment/config | Current documents `PORT`, `DB_PATH`, `DASHBOARD_PASSWORD`; code also supports undocumented `CLIENT_ID` and `ANTHROPIC_API_BASE`. | Reference central config documents `CLIENT_ID`, DB/Postgres vars, session duration, payload encryption, TLS/auth settings, etc. | Current has hidden OAuth/proxy knobs. Reference is more configurable. |
| Tests | Current tests strict state mismatch, malformed code, retryable token exchange, session consumption, auth headers, dashboard auth, and E2E OAuth dialog URL. | Reference tests REST OAuth init modes/validation, provider parser/errors, PKCE, API auth exemptions/RBAC, repository behavior, and reauth variants. | Current has stronger local state-validation tests; reference has broader feature/route/provider coverage. |

## High-Signal Takeaways

1. Keep current server-side OAuth `state` validation.
2. Keep reauth bound to account ID instead of account name.
3. Add REST compatibility only deliberately; it changes auth and API contracts.
4. Add proxy API-key auth before exposing `/v1/*` publicly.
5. If adding console/API-key mode, update schema, routing, header rewriting, frontend flow, and tests together.
6. Document `CLIENT_ID` and `ANTHROPIC_API_BASE` if they remain supported.
