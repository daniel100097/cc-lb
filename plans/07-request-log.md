# 07 — Request Log

A first-class request log page like codex-lb's "Recent requests" and ccflare's
"Requests" tab: every proxied request visible in the dashboard with account,
model, outcome, latency, token usage, and failover context — filterable and
paginated.

Reference implementations studied:
- codex-lb: `reference/codex-lb/app/modules/request_logs/api.py` (paginated +
  faceted filters), `app/db/models.py:177` (54-column `request_logs` table),
  `frontend/.../recent-requests-table.tsx` (table + detail modal, 30s polling)
- better-ccflare: `packages/database/src/repositories/request.repository.ts`
  (26-column summary table), `packages/http-api/src/handlers/requests.ts`
  (summary/detail endpoints), SSE live stream

We already have the skeleton: `request_log` table (6 columns), `logRequest()`
called at 5 outcome sites in `src/proxy/handler.ts`, and `stats.recentRequests`
(last 12) on the dashboard. This plan upgrades it to the reference feature set,
staying summary-focused like ccflare (no request/response body capture — that's
a non-goal, see bottom).

## 1. Schema — widen `request_log`

Migration `004_request_log_details` in `src/db/client.ts` (ALTER TABLE ADD
COLUMN, matching the existing ordered-SQL migration pattern):

```sql
ALTER TABLE request_log ADD COLUMN method            TEXT;
ALTER TABLE request_log ADD COLUMN path              TEXT;
ALTER TABLE request_log ADD COLUMN failover_attempt  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_log ADD COLUMN latency_ms        INTEGER;  -- to response headers
ALTER TABLE request_log ADD COLUMN total_ms          INTEGER;  -- to stream end
ALTER TABLE request_log ADD COLUMN error             TEXT;     -- network/token error detail
ALTER TABLE request_log ADD COLUMN upstream_request_id TEXT;   -- Anthropic request-id header
ALTER TABLE request_log ADD COLUMN input_tokens      INTEGER;
ALTER TABLE request_log ADD COLUMN output_tokens     INTEGER;
ALTER TABLE request_log ADD COLUMN cache_read_tokens     INTEGER;
ALTER TABLE request_log ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE request_log ADD COLUMN cost_usd          REAL;     -- from anthropic-billing-cost header
CREATE INDEX IF NOT EXISTS idx_request_log_outcome_ts ON request_log(outcome, ts);
```

Mirror the new columns in `src/db/schema.ts` (`requestLog` table). Existing
rows keep NULLs — the UI must tolerate that.

Keep the per-attempt row model we already have (one row per account attempt,
`failover_attempt` = attempt index), and keep the 30-day prune in
`src/db/request-log.ts:55`.

## 2. Capture — enrich `logRequest()` call sites

All changes in `src/proxy/handler.ts`.

**Pass request context into `attempt()`**: `method`, `path` (`url.pathname`),
`model` (from `parsedBody.model` — already parsed at line 30-37 for sticky
keys, currently unused for logging), and the attempt index from the failover
loop at line 48.

**Timing**: `performance.now()` before the `fetch` at line 89; `latency_ms` =
elapsed when headers arrive.

**Error detail**: the two catch blocks (token error line 79, network error
line 95) currently swallow the exception — capture `String(err)` into the new
`error` column.

**Token usage (the interesting part)** — success path only (line 118-123).
`logRequest()` inserts the row and returns `lastInsertRowid`; usage arrives
later, so a background task UPDATEs the row:

- `upstream.body.tee()` — one branch streams to the client unchanged, the
  other is consumed in the background.
- Content-type `text/event-stream`: parse SSE lines for `message_start`
  (`usage.input_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`) and `message_delta` (`usage.output_tokens`).
  This is what ccflare does in its usage extraction.
- Content-type `application/json`: buffer the tee'd branch, parse `usage`
  from the response body.
- When the tee'd branch ends: `updateRequestLogUsage(id, { tokens…, total_ms,
  cost_usd })`. Fire-and-forget with a `.catch()` — must never block or fail
  the client response.
- `upstream_request_id` from the upstream `request-id` response header.

**Cost**: read `anthropic-billing-cost` from the upstream response header, matching
better-ccflare. If the header is absent or invalid, keep `cost_usd` NULL. Label it
"est." in the UI because OAuth/subscription accounting is still operational
telemetry, not billing authority.

## 3. DB module — `src/db/request-log.ts`

Extend `RequestLogInput` with the new fields; add:

```ts
logRequest(input): number                      // now returns row id
updateRequestLogUsage(id, patch): void         // tokens, total_ms, cost_usd, upstream_request_id
listRequests(filter): { entries, total }       // paginated + filtered
listRequestModels(): string[]                  // DISTINCT model, for the filter dropdown
```

`listRequests` filter: `{ limit (1-200), offset, accountId?, outcome?,
model?, since?, until?, search? }` — search does LIKE on `path`/`model`/
`error`. Entries JOIN `accounts` for the display name (ccflare does the same
in its summary handler; account may be deleted → name NULL, show the raw id).

## 4. API — tRPC `requests` router

New sub-router in `src/api/router.ts` next to `accounts`/`settings`:

```ts
requests: router({
  list:    publicProcedure.input(requestFilterSchema).query(...)  // → { entries, total, hasMore }
  options: publicProcedure.query(...)  // → { accounts: {id,name}[], models: string[], outcomes: string[] }
})
```

`outcomes` is the fixed set already emitted by the handler: `ok`,
`rate_limited`, `unauthorized`, `network_error`, `token_error`. `stats` query
stays as-is (dashboard's mini "recent requests" card keeps working).

## 5. Frontend — `/requests` page

- New route in `frontend/src/App.tsx` (routes at line 89-93) + nav pill
  "Requests" in the top-bar segmented nav.
- **Filter bar**: account select, outcome select, model select (from
  `requests.options`), timeframe pills (1h / 24h / 7d / all → `since`,
  codex-lb style), search input.
- **Table columns**: time (relative, `lib/format.ts` helpers), account,
  model, outcome (`status-badge.tsx` with new outcome→tone map: ok→emerald,
  rate_limited→orange, unauthorized→sky, network_error/token_error→red),
  HTTP status, tokens (in/out, cache on hover or expanded), est. cost,
  latency, attempt # (only shown when > 0).
- **Row expansion** (collapsible, like ccflare's RequestsTab) for the long
  tail: path, error text, upstream request id, cache token breakdown,
  total_ms.
- **Pagination**: limit/offset with total count from `list`.
- **Live-ish updates**: react-query `refetchInterval: 15_000` +
  `refetchOnWindowFocus` — the codex-lb polling approach. SSE streaming
  (ccflare) is a non-goal for now.
- Respect the existing privacy mode (`use-privacy.ts`) — blur account names
  like the accounts page does.

## 6. Tests

- `src/db/request-log.test.ts` — insert/update/filter/pagination against
  `:memory:` DB (set `DB_PATH=:memory:` like existing db tests).
- `src/api/router.test.ts` — extend with `requests.list` filter cases.
- New `src/proxy/usage.test.ts` — SSE usage parser over a canned Anthropic
  event stream + JSON body variant.
- `tests/e2e/smoke.spec.ts` — navigate to `/requests`, assert filter bar +
  empty state render.

## Verification

1. `bun run test` — unit suites above.
2. `bun run dev`, open dashboard → Requests page, empty state renders.
3. Point Claude Code at the proxy (or `curl -X POST localhost:8484/v1/messages`
   with a real account), confirm: row appears within one poll interval,
   tokens/cost populate after the stream completes, latency and account name
   correct.
4. Kill network / use an expired account → `network_error` / `token_error`
   rows carry the error text; failover attempts show incrementing attempt #.
5. `bun run test:e2e` — smoke passes.

## Non-goals (explicitly out, revisit later)

- Request/response **body capture** (ccflare's encrypted `request_payloads`
  table) — privacy + storage cost, not needed for operations.
- **SSE live streaming** to the dashboard — polling is fine at this scale.
- Soft-delete / audit retention (codex-lb's `deleted_at`) — 30-day hard prune
  stays.
- Logging enable/disable toggle — both references are always-on.
