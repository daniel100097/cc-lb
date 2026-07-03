# 03 — Load Balancing

Strategy set and state machine adapted from
[codex-lb research](../docs/research/codex-lb-load-balancing.md); rate-limit
semantics from [better-ccflare research](../docs/research/better-ccflare-anthropic.md).
codex-lb tracks credit/quota windows we can't read from Anthropic OAuth accounts,
so we adapt its ideas to the signals we *do* have: `rate_limited_until`,
`rate_limit_reset`, `rate_limit_remaining`, `priority`, `request_count`,
`session_start`, `consecutive_rate_limits`.

## AccountState (pure input, `src/balancer/types.ts`)

```ts
interface AccountState {
  id: string;
  priority: number;              // lower = preferred
  paused: boolean;
  rateLimitedUntil: number | null;
  rateLimitReset: number | null; // usage-window reset (ms)
  rateLimitRemaining: number | null;
  requestCount: number;
  sessionStart: number | null;
  lastUsed: number | null;
  consecutiveRateLimits: number;
}
```

`isAvailable(a, now) = !a.paused && (!a.rateLimitedUntil || a.rateLimitedUntil < now)`
(better-ccflare `isAccountAvailable`).

## Strategies (`src/balancer/strategies.ts`, pure functions)

Ship a focused subset of codex-lb's eight — the ones meaningful without credit data:

| Strategy | Pick rule | Notes |
|---|---|---|
| `priority` (default) | lowest `priority`, tie → lowest `requestCount` | better-ccflare-style ordered failover; simple + predictable |
| `round_robin` | least-recently-used: min `lastUsed` then id | even spread |
| `least_used` | min `requestCount` (this session) | codex-lb `usage_weighted` analog |
| `weighted_random` | random weighted by `rateLimitRemaining` (fallback: equal) | codex-lb `capacity_weighted` analog; spreads load, avoids thundering herd |
| `session_reset_drain` | prefer account whose `rateLimitReset` is soonest among available | codex-lb `reset_drain` analog; drains the account closest to a fresh window |

Signature:
```ts
type Strategy = (available: AccountState[], now: number, ctx: SelCtx) => AccountState | null;
```
Selection = filter to available → apply strategy → return winner (or null → pool exhausted). Never mutate in the pure layer.

## Session affinity (simplified codex-lb stickiness)

Optional, setting `stickySessions` (default on). Sticky key derived per request:
1. If body/header carries a session id (`x-cc-session-id`, or Anthropic `metadata.user_id`) → use it.
2. Else hash `(first system prompt + first user message + model)` → stable key (codex-lb `_derive_prompt_cache_key` idea) — keeps a Claude Code conversation on one account so prompt-cache stays warm and the 5-hour window is shared.

`sticky_sessions(key TEXT, account_id TEXT, updated_at INTEGER, PRIMARY KEY(key))`.
On select: if a mapping exists and that account `isAvailable` → reuse it. If pinned account is temporarily rate-limited **but still in pool**, pick a fallback **without overwriting** the mapping (codex-lb behavior) so the session returns home on recovery. TTL = `stickyTtlMs` (default 5h, matching the Anthropic window). Cleanup on boot + hourly.

## 5-hour session window (from better-ccflare SessionStrategy)

- On a successful request, if `session_start` is null or (`now - session_start > 5h`) or (`rate_limit_reset` is set and `< now-1000`) → start a new session: `session_start=now`, `session_request_count=0`. Else increment.
- Used by `session_reset_drain` and stickiness to reason about window freshness.

## Rate-limit parsing (`src/proxy/rate-limit.ts`)

Copy better-ccflare `parseRateLimit`. Read headers:
```
anthropic-ratelimit-unified-status
anthropic-ratelimit-unified-reset       (unix seconds)
anthropic-ratelimit-unified-remaining
```
Account is rate-limited if: status ∈ {`rate_limited`,`blocked`,`queueing_hard`,`payment_required`}, OR HTTP 429, OR HTTP 529.

Reset time:
- non-529: `Number(reset) * 1000`.
- 529: try unified-reset → `Retry-After` (delta or HTTP-date) → `x-ratelimit-reset`.
- 429 w/o headers: default 60s cooldown.
`clampResetTime`: reject NaN/past/infinite, cap at 24h from now.

**Persist metadata on every response** carrying a status header (even 200s):
`rate_limit_status`, `rate_limit_reset`, `rate_limit_remaining`. This keeps
`rate_limit_reset` tracking the true window reset — needed for drain/stickiness.

## Applying a cooldown (`applyCooldown`)

Copied from better-ccflare `applyRateLimitCooldown`:
```
n = consecutive_rate_limits + 1
backoff = min(BASE * 2^(n-1), MAX)          // BASE=30s, MAX=5min
cooldownUntil = resetTime ? min(resetTime, now+backoff) : now+backoff
```
Set `rate_limited_until=cooldownUntil`, bump `consecutive_rate_limits`, record reason. On any success, clear `rate_limited_until`; reset `consecutive_rate_limits` after the account has been healthy 5 min.

## Failover loop (`src/proxy/handler.ts`)

Order accounts by strategy → iterate:
- 2xx → stream back, update session/counters, clear error state. **Done.**
- 401 → try next (don't cool; flag for re-auth if refresh already failed).
- 429/529/hard-status → `applyCooldown`, try next. For reset-less 529, do up to 2 in-place jittered retries first (better-ccflare overload retry) before cooling.
- network/timeout → bump transient error, try next.
- All exhausted → 503 `pool_exhausted` with per-account `available_at` + `Retry-After` = earliest `rate_limited_until`.

Mid-stream SSE rate-limit sniffer (better-ccflare): while teeing a 200 stream, watch for an `event: error` frame with `"type":"rate_limit_error"`/`"overloaded_error"` within the first ~16KB; if seen, apply a probe cooldown to that account after the stream.

## Settings (`settings` table, single row JSON or key/value)

```
strategy               = "priority"
stickySessions         = true
stickyTtlMs            = 18000000   // 5h
rateLimitBackoffBaseMs = 30000
rateLimitBackoffMaxMs  = 300000
sessionDurationMs      = 18000000   // 5h
overloadRetryMax       = 2
```
Editable via `PATCH /api/settings`, surfaced in the Settings page (plan 04).
