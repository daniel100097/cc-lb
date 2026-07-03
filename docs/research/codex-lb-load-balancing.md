# codex-lb — Load Balancing

## 1. Overall Architecture

**Language / framework.** codex-lb is a Python 3.13 application built on **FastAPI** (ASGI), using **SQLAlchemy (async)** with **Alembic** migrations over **SQLite or Postgres**, and a **React/Vite** dashboard frontend. Package management is via `uv`. The app is a reverse proxy in front of OpenAI's Codex/ChatGPT backend that pools multiple ChatGPT OAuth accounts and load-balances requests across them.

**Entry points.**
- `app/main.py:341` `create_app()` builds the `FastAPI` app and mounts the proxy routers: `app.include_router(proxy_api.router)` and siblings at `app/main.py:384-389`.
- Proxy routers live in `app/modules/proxy/api.py:210-248`, prefixed `/backend-api/codex` (native Codex), `/backend-api/wham` (usage), `/v1` (OpenAI-compatible), plus WebSocket and internal-bridge routers. The main inference route is `POST /v1/responses` / `/backend-api/codex/responses` (streaming Responses API).
- `app/main.py:119` `lifespan()` starts background schedulers (usage refresh, sticky-session cleanup, etc.).

**Request flow (happy path).**
1. A client request lands on a proxy route in `app/modules/proxy/api.py`, which delegates to `ProxyService` (`app/modules/proxy/service.py`).
2. `ProxyService` computes a **sticky-affinity policy** for the request from the payload and headers via `app/modules/proxy/affinity.py` (`_sticky_key_for_responses_request`, `affinity.py:287`), yielding an `_AffinityPolicy(key, kind, reallocate_sticky, max_age_seconds)`.
3. It reads operator routing settings (`DashboardSettings`) and calls the account picker: `self._load_balancer.select_account(...)` (e.g. `service.py:1366`, `service.py:1778`).
4. `LoadBalancer` (`app/modules/proxy/load_balancer.py:165`) builds per-account `AccountState` snapshots from DB rows + in-memory runtime state, then delegates the actual choice to the pure selector `select_account()` in `app/core/balancer/logic.py:357`.
5. The chosen account's OAuth token is used to forward the request upstream (via `app/core/clients/`), streaming the SSE/websocket response back.
6. On upstream failure, `ProxyService._handle_proxy_error` (`service.py:1902`) classifies the error and either fails over to another account or surfaces it; account health/quota state is mutated and persisted.

There are two clear layers:
- **`app/core/balancer/`** — *pure*, stateless-ish selection logic and account-state math (no DB, no async). This is the algorithmic core.
- **`app/modules/proxy/load_balancer.py`** — the *stateful orchestrator*: loads accounts + usage from the DB, maintains in-memory runtime state (error counts, cooldowns, in-flight leases, health tiers), applies sticky routing, persists results, and handles concurrency.

---

## 2. Load Balancing Strategy / Strategies

### Configured strategies

The selection algorithm is chosen by an operator setting `routing_strategy`. The full set is defined as the `RoutingStrategy` literal at `app/core/balancer/logic.py:58-67`:

```
usage_weighted | round_robin | capacity_weighted | relative_availability |
fill_first | sequential_drain | reset_drain | single_account
```

The operator-facing descriptions are in `README.md:54-63`. Default is **`capacity_weighted`** (`app/modules/settings/repository.py:30`).

### Where the strategy is applied

The core entry is `select_account(states, ..., routing_strategy=...)` at `app/core/balancer/logic.py:357`. It runs in two phases:

**Phase A — hard eligibility filtering** (`logic.py:435-546`). Each `AccountState` is checked and either added to `available`, held in `in_error_backoff`, or dropped:
- `REAUTH_REQUIRED` / `DEACTIVATED` / `PAUSED` → skipped (`logic.py:442-445`).
- `RATE_LIMITED` → skipped unless `reset_at` has passed (then reset to ACTIVE in place) (`logic.py:446-453`).
- `QUOTA_EXCEEDED` → skipped unless `reset_at` passed (`logic.py:454-461`).
- `cooldown_until` in the future → skipped (`logic.py:462-467`).
- `error_count >= 3` → exponential backoff `min(300, 30 * 2^(error_count-3))` seconds; if still inside the window, moved to `in_error_backoff`; if expired, error state is cleared and the account re-enters the pool (`logic.py:468-481`).
- If nothing is `available`, an `allow_backoff_fallback` path may re-admit the backoff account closest to recovery (`logic.py:503-509`), otherwise a descriptive error is returned (`logic.py:515-546`).

**Phase B — health-tier + policy filtering, then strategy** (`logic.py:596-653`):
- Accounts are bucketed by **health tier**: `healthy or probing or draining or available` → `health_pool` (`logic.py:596-599`).
- Within that, **routing policy** buckets: `burn_first or normal or preserve` → `effective_pool` (`logic.py:600-603`).
- The chosen strategy picks the winner from `effective_pool`:

| Strategy | Code path | How the winner is picked |
|---|---|---|
| `single_account` | `logic.py:584-586` | `min(available, key=account_id)` — deterministic single account. |
| `sequential_drain` | `logic.py:588-590` | `min` by `_sequential_drain_sort_key` = (configured capacity credits, hashed tiebreak, id) — drains in a fixed order (`logic.py:877-882`). |
| `reset_drain` | `logic.py:592-593` | `min` by `_reset_drain_sort_key` = (reset-bucket days, −primary remaining, −secondary remaining, reset time…) — prioritizes accounts near reset (`logic.py:893-913`). |
| `round_robin` | `logic.py:606-607` | `min` by `_round_robin_sort_key` = (planner cost, `last_selected_at`, id) — least-recently-selected wins (`logic.py:580-582`). |
| `capacity_weighted` | `logic.py:608-618` | `_select_capacity_weighted`: **weighted random** `random.choices` with weight = remaining secondary (weekly) credits (`logic.py:941-948`). Deterministic-probe mode instead sorts by most-remaining-credits (`logic.py:916-928`). |
| `relative_availability` | `logic.py:619-627` | `_select_relative_availability`: score = remaining_credits ÷ seconds-until-reset, normalized to the best, raised to `power`, filtered to `top_k`, then weighted random draw (`logic.py:761-864`). |
| `fill_first` | `logic.py:628-634` | `_select_fill_first`: `min` by `_fill_first_sort_key` = (−primary used%, −secondary used%, id) — most-saturated account first (`logic.py:951-974`). |
| `usage_weighted` (else) | `logic.py:635-652` | `min` by usage sort key: least-used wins, ranking secondary-window pressure first (`_usage_sort_key`, `logic.py:165-169`) or primary-first if configured. |

### The orchestrator wrapper adds "budget-safe" preference

Before hitting `select_account`, the `LoadBalancer` routes through `_select_account_preferring_budget_safe` (`load_balancer.py:2409`). This:
1. Prefers the best health tier (`_best_health_tier_states`, `load_balancer.py:2529`).
2. Prefers `burn_first`-policy accounts when present (`load_balancer.py:2459-2475`).
3. Prefers accounts **not** in `preserve` policy and **below** the budget threshold (default primary 95%, secondary 100%) — `preferred_states` at `load_balancer.py:2477-2500`.
4. Falls back to the full pool if none qualify.

There is also a **quota planner** cost overlay: `build_routing_costs(...)` (`load_balancer.py:421`, `app/modules/quota_planner/logic.py`) produces per-account `RoutingCost`; `select_account` applies these as a *tiebreak after hard eligibility* — lowest planner cost wins (`_planner_cost`, `logic.py:156`; `_lowest_planner_cost_candidates`, `logic.py:931`).

### Selection concurrency & retry

`LoadBalancer.select_account` (`load_balancer.py:287`) runs the selection under an `asyncio.Lock`, snapshots runtime state, persists the winner's status via optimistic concurrency (`_persist_state_if_current`, `load_balancer.py:1614` — a compare-and-set on the prior status/reset), and **retries up to `_MAX_SELECTION_ATTEMPTS = 4`** (`load_balancer.py:74`) if the persist was stale or the selection-inputs cache generation changed mid-flight (`load_balancer.py:516-577`). This makes selection safe under concurrent requests.

A **rendezvous / HRW hash** helper exists (`app/core/balancer/rendezvous_hash.py:7`, `select_node`) used for distributing keys across nodes with minimal remapping (used by ring-membership `app/modules/proxy/ring_membership.py`), but it is not the per-request account picker.

---

## 3. Account State Model

### Statuses

`AccountStatus` enum (`app/db/models.py:41-47`):
- `ACTIVE` — eligible.
- `RATE_LIMITED` — hit a short-window rate limit; carries `reset_at`.
- `QUOTA_EXCEEDED` — hit a quota/usage limit; `used_percent=100`, `reset_at` set.
- `PAUSED` — operator-disabled; never selected.
- `REAUTH_REQUIRED` — OAuth refresh permanently failed; needs re-login.
- `DEACTIVATED` — account deactivated/suspended/deleted upstream.

`_selectable_accounts` (`load_balancer.py:2219`) drops `REAUTH_REQUIRED`, `DEACTIVATED`, `PAUSED` before selection even begins. Recoverable statuses are `ACTIVE`, `RATE_LIMITED`, `QUOTA_EXCEEDED` (`load_balancer.py:79`).

### Routing policy (per account)

`AccountRoutingPolicy` (`app/db/models.py:50-53`): `normal` / `burn_first` / `preserve`, persisted on the `Account` row (`models.py:83`). `burn_first` accounts are drained first; `preserve` accounts are held back and only used for opportunistic burn when floors allow (`logic.py:251-320`).

### Usage / quota tracking

Two quota "windows" are tracked per account:
- **Primary** = short (~5-hour) window; **Secondary** = weekly (7-day) window. Absolute credit capacity per plan comes from `PLAN_CAPACITY_CREDITS_SECONDARY` and `usage_core.capacity_for_plan` (`logic.py:11`, `load_balancer.py:1524`).
- Usage is stored in the `usage_history` table (`models.py:145`) with `used_percent`, `reset_at`, `window_minutes`, `credits_*`. Model-gated pools use `additional_usage_history` (`models.py:162`).

The runtime `AccountState` (`logic.py:109-137`) carries the derived signals used by the selector: `used_percent`, `secondary_used_percent`, `reset_at`, `secondary_reset_at`, `cooldown_until`, `error_count`, `last_error_at`, `last_selected_at`, `capacity_credits`, `health_tier`, `routing_policy`, and in-flight lease counts (`inflight_response_creates`, `inflight_streams`, `leased_tokens`).

### Persistence vs. in-memory runtime

- **DB-persisted** (survives restart): `Account.status`, `deactivation_reason`, `reset_at`, `blocked_at` (`models.py:97-109`); usage rows; sticky mappings; settings. Persisted through `_persist_state` / `_persist_state_if_current` (`load_balancer.py:1588-1645`).
- **In-memory runtime** (`RuntimeState`, `load_balancer.py:102-118`): `cooldown_until`, `error_count`, `last_error_at`, `last_selected_at`, `health_tier`, `drain_entered_at`, `probe_success_streak`, in-flight leases, and a `version` counter for optimistic sync. Kept in `LoadBalancer._runtime: dict[str, RuntimeState]` guarded by `_runtime_lock`. `_state_from_account` (`load_balancer.py:1823`) merges DB rows + runtime + usage into an `AccountState`, treating `Account.reset_at`/`blocked_at` as authoritative so rate-limit/quota state survives restarts (`load_balancer.py:1898-1907`).

### Background usage refresh (quota tracking loop)

`UsageRefreshScheduler` (`app/core/usage/refresh_scheduler.py:120`) runs every `usage_refresh_interval_seconds` (default 60), round-robining through accounts one per slice (`_select_next_account`, `refresh_scheduler.py:222`), fetching fresh usage from upstream and writing `usage_history`. It is **leader-elected** (`refresh_scheduler.py:158`) so only one node refreshes.

### In-flight capacity leases

Beyond quota, per-account concurrency is capped by **leases** (`AccountLease`, `load_balancer.py:120`). `acquire_account_lease` (`load_balancer.py:180`) enforces `proxy_account_response_create_limit` and `proxy_account_stream_limit`; over-cap accounts are filtered out during selection (`_filter_states_for_account_caps`, `load_balancer.py:1705`). Stale leases are reclaimed after a TTL (`_reclaim_stale_account_leases_locked`, `load_balancer.py:273`).

---

## 4. Rate Limit & Error Handling

### Classification (what triggers what)

Upstream errors are classified by `classify_upstream_failure` (`app/modules/proxy/helpers.py:42-64`) into a `FailureClass`:
- `rate_limit` — codes `rate_limit_exceeded`, `usage_limit_reached` (`helpers.py:37`).
- `quota` — `insufficient_quota`, `usage_not_included`, `quota_exceeded` (`helpers.py:38`).
- `retryable_transient` — `server_error`, `upstream_error`, `stream_incomplete`, `overloaded_error`, or any HTTP ≥ 500 (`helpers.py:39,54`).
- `non_retryable` — everything else.

Permanent auth failures are a separate set: `PERMANENT_FAILURE_CODES` and `REAUTH_REQUIRED_FAILURE_CODES` (`logic.py:15-47`) — expired/reused/revoked refresh tokens, terminated sessions, deactivated/suspended accounts.

### Applying the failure to account state

`_handle_stream_error` (`app/modules/proxy/_service/streaming/helpers.py:744-773`) dispatches on the class:
- `rate_limit` → `LoadBalancer.mark_rate_limit` → `handle_rate_limit` (`logic.py:977-991`): sets `RATE_LIMITED`, increments `error_count`, sets `blocked_at`, extracts `reset_at` from `resets_at`/`resets_in_seconds` (`_extract_reset_at`, `logic.py:1059`), and sets `cooldown_until = now + delay` where `delay` = parsed `Retry-After` or `backoff_seconds(error_count)`.
- `quota` → `mark_quota_exceeded` → `handle_quota_exceeded` (`logic.py:1013-1023`): sets `QUOTA_EXCEEDED`, `used_percent=100`, `cooldown_until = now + 120s` (`QUOTA_EXCEEDED_COOLDOWN_SECONDS`, `logic.py:994`), `reset_at` from error or `now + 3600`.
- Permanent code → `mark_permanent_failure` → `handle_permanent_failure` (`logic.py:1026-1038`): sets `REAUTH_REQUIRED` (for reauth codes) or `DEACTIVATED`, records `deactivation_reason`, and calls `mark_account_routing_unavailable` (`load_balancer.py:1470`).
- Otherwise → `record_error` (`load_balancer.py:1473`): increments transient `error_count`, sets `last_error_at`.

Each mark path takes a per-account lock, syncs runtime, persists to DB, and invalidates the selection-inputs cache (`load_balancer.py:1442-1471`).

### Failover decision

`failover_decision` (`logic.py:1044-1056`) decides per attempt: if the error is already **downstream-visible** or there are **no candidates remaining**, `surface`; if the class is `rate_limit`/`quota`/`retryable_transient`, `failover_next`; else `surface`. In `ProxyService`, failover is driven by re-calling `select_account(exclude_account_ids={failed_account.id})` (e.g. `service.py:1070`, `service.py:1161`, `service.py:1792`) so the failed account leaves the pool for the retry. `_ensure_previsible_unary_fresh_with_failover` / `_retry_previsible_unary_call_failover` (`service.py:1429`, `service.py:1523`) implement the retry loop for unary calls; the streaming path retries via `_ACCOUNT_RECOVERY_RETRY_CODES` (`helpers.py:786`).

### Retry / backoff / cooldown

- **Cooldown** (`cooldown_until`): set on rate-limit (Retry-After or exponential backoff) and quota (120 s). Accounts inside cooldown are skipped (`logic.py:462-467`).
- **Error backoff**: at `error_count >= 3`, `min(300, 30 * 2^(error_count-3))` seconds (`logic.py:468-479`, mirrored in `_backoff_expires_at` `logic.py:505`). Caps at 300 s.
- **Retry-hint clamp**: user-visible "Try again in Ns" is clamped to `SELECTOR_RETRY_HINT_MAX_SECONDS = 300` (`logic.py:1005-1010`).

### Recovery paths

- **Inline lazy recovery**: in `select_account`, a `RATE_LIMITED`/`QUOTA_EXCEEDED` account whose `reset_at` has passed is flipped back to `ACTIVE` (usage zeroed) on the spot (`logic.py:446-461`). Expired error backoff clears `error_count`/`last_error_at` (`logic.py:479-480`).
- **Successful request** clears transient error state via `record_success` (`load_balancer.py:1493-1504`).
- **Background reconciliation**: after each usage refresh, `reconcile_recoverable_account_statuses` (`refresh_scheduler.py:268-323`) re-checks `RATE_LIMITED`/`QUOTA_EXCEEDED` accounts against fresh usage and flips them back to `ACTIVE` (via optimistic `update_status_if_current`) when the window has recovered — using the persisted `blocked_at` marker so recovery survives restarts.

### Health tiers (soft draining)

Independent of hard status, `evaluate_health_tier` (`logic.py:1069-1127`) assigns a soft tier: `HEALTHY(0)` → `DRAINING(1)` → `PROBING(2)`. An account **drains** when primary used ≥ 85% (`DRAIN_PRIMARY_THRESHOLD_PCT`), secondary ≥ 90%, or ≥ 2 errors within 60 s (`logic.py:86-91`, `1093-1106`). After a quiet period it moves to `PROBING`, and recovers to `HEALTHY` after `PROBE_SUCCESS_STREAK_REQUIRED = 3` successes (`logic.py:1120-1125`). The selector prefers the best available tier (`logic.py:596-599`, `_best_health_tier_states` `load_balancer.py:2529`). There's also an upstream **circuit breaker**: if all account breakers are open, the balancer enters degraded mode (`load_balancer.py:2540`, `resilience/circuit_breaker.py`).

---

## 5. Session Affinity / Sticky Routing

Sticky routing is a first-class feature. Three sticky **kinds** exist (`StickySessionKind`, `models.py:56-59`): `CODEX_SESSION`, `STICKY_THREAD`, `PROMPT_CACHE`.

**Key derivation** (`app/modules/proxy/affinity.py`):
- `_sticky_key_for_responses_request` (`affinity.py:287`) picks, in priority order: an `x-codex-turn-state` header → `CODEX_SESSION`; a session header (`session_id`, `x-codex-session-id`, `x-codex-conversation-id`, `thread-id`) → `CODEX_SESSION` (`affinity.py:175-184`); an OpenAI prompt-cache key → `PROMPT_CACHE` with a TTL; else, if sticky threads enabled, a derived key → `STICKY_THREAD` with `reallocate_sticky=True` (`affinity.py:311-330`).
- When no prompt-cache key is supplied, one is **derived** deterministically from (model-class, api-key, instructions, first user input) so a session's turns hash to the same key (`_derive_prompt_cache_key`, `affinity.py:63-99`).

**Persistence**: the `sticky_sessions` table (`models.py:393`, PK `(key, kind)` → `account_id`, `updated_at`), managed by `StickySessionsRepository` (`app/modules/proxy/sticky_repository.py:34`). `get_account_id` honors `max_age_seconds` and deletes expired mappings (`sticky_repository.py:38-55`). A cleanup scheduler prunes old rows (`app/modules/sticky_sessions/cleanup_scheduler.py`).

**Selection with stickiness** (`LoadBalancer._select_with_stickiness`, `load_balancer.py:1203`):
- If a mapping exists and the pinned account is selectable, it is reused (and re-upserted for TTL kinds) (`load_balancer.py:1258-1324`).
- If the pinned account is temporarily unavailable (rate-limited/backoff) but still in the pool, a **fallback is chosen without overwriting the mapping** so the session returns to its warm-cache account once it recovers (`load_balancer.py:1249-1255`, `1387-1420`); only `reallocate_sticky=True` (`STICKY_THREAD`) permanently reassigns.
- **Budget-pressure rebind**: if the pinned account exceeds the sticky budget threshold (default primary 95% / secondary 100%, `sticky_reallocation_*` settings), affinity is proactively re-evaluated — but only rebinds if the pool actually has a meaningfully-better candidate, avoiding cache thrashing (`load_balancer.py:1266-1380`).
- **Grace period**: a rate-limited pinned account with a reset within `_STICKY_GRACE_PERIOD_SECONDS = 10s` (`load_balancer.py:77`) is retried with a small time advance to preserve prompt-cache locality (`load_balancer.py:1387-1402`).
- `CODEX_SESSION` mappings are "hard sticky" and bypass the per-account concurrency-cap filter (`load_balancer.py:614-618`).

---

## 6. Configuration

Load balancing is configured through **dashboard settings persisted in the `dashboard_settings` DB table** (`models.py`, `DashboardSettings`), not environment variables. The operator edits them via the dashboard UI, backed by `PATCH` on the settings API (`app/modules/settings/api.py:591`, `service.py:155`, `repository.py:74-133`).

Key load-balancing settings (schema + validation in `app/modules/settings/schemas.py:34-72`; defaults in `app/modules/settings/repository.py:21-61`):

| Setting | Default | Meaning |
|---|---|---|
| `routing_strategy` | `capacity_weighted` | One of the 8 strategies; regex-validated (`schemas.py:42-44`). |
| `single_account_id` | `None` | Target for `single_account` strategy. |
| `relative_availability_power` | `2.0` | Weighting exponent (`schemas.py:45`). |
| `relative_availability_top_k` | `5` | Candidate pool size, 1–20 (`schemas.py:46`). |
| `prefer_earlier_reset_accounts` | `True` | Bias toward accounts resetting sooner. |
| `prefer_earlier_reset_window` | `secondary` | Which window (`primary`/`secondary`) drives that bias. |
| `sticky_threads_enabled` | `True` | Enable `STICKY_THREAD` affinity. |
| `openai_cache_affinity_max_age_seconds` | (env default) | TTL for `PROMPT_CACHE` sticky mappings. |
| `sticky_reallocation_primary/secondary_budget_threshold_pct` | `95.0` / `100.0` | Budget thresholds for sticky rebind. |
| `additional_quota_routing_policies` | `{}` | Per-model-gated-quota routing overrides (`inherit`/`normal`/`burn_first`/`preserve`, `schemas.py:30`). |

The `_routing_strategy(settings)` helper (`app/modules/proxy/service.py:2163-2179`) maps the stored string to the `RoutingStrategy` literal, defaulting to `capacity_weighted` for any unknown value. `_relative_availability_power` / `_top_k` / `_prefer_earlier_reset_window` (`service.py:2205-2218`) clamp and normalize the other knobs before they reach `LoadBalancer.select_account`.

Per-account configuration (in the `accounts` table, editable via the accounts API `app/modules/accounts/api.py`): `routing_policy` (`normal`/`burn_first`/`preserve`), `status` (e.g. operator `PAUSED`), `security_work_authorized`, `plan_type`, and `limit_warmup_enabled`.

Environment/`.env` controls surrounding infrastructure (concurrency caps `proxy_account_response_create_limit` / `proxy_account_stream_limit`, `usage_refresh_interval_seconds`, `usage_refresh_enabled`, circuit-breaker toggles, bulkhead limits) via `app/core/config/settings.py`, but the load-balancing *algorithm* selection is a runtime dashboard setting.

---

## Key files reference

- `app/core/balancer/logic.py` — pure selection algorithm, all 8 strategies, health tiers, rate-limit/quota/permanent-failure state transitions, backoff math.
- `app/core/balancer/types.py` — `UpstreamError`, `FailureClass` types.
- `app/core/balancer/rendezvous_hash.py` — HRW hashing for node/ring distribution (not per-request picking).
- `app/modules/proxy/load_balancer.py` — stateful orchestrator: DB loading, runtime state, sticky routing, concurrency, leases, persistence, retries.
- `app/modules/proxy/affinity.py` — sticky-key derivation and affinity policy.
- `app/modules/proxy/sticky_repository.py` — sticky-mapping persistence (`sticky_sessions` table).
- `app/modules/proxy/helpers.py:42` — upstream failure classification.
- `app/modules/proxy/_service/streaming/helpers.py:744` — dispatch of classified failures into `mark_*`/`record_error`.
- `app/modules/proxy/service.py` — request orchestration, failover loops, traffic-class derivation.
- `app/core/usage/refresh_scheduler.py` — background usage refresh + account status recovery.
- `app/modules/settings/{schemas,service,repository}.py` — routing configuration schema, defaults, persistence.
- `app/db/models.py:41-59` — `AccountStatus`, `AccountRoutingPolicy`, `StickySessionKind` enums and `Account`/`UsageHistory`/`StickySession` tables.
- `README.md:48-63` — operator-facing routing-strategy guide.
