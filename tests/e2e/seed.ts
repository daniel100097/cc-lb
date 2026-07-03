import { rmSync } from "node:fs";

const dbPath = process.env.DB_PATH ?? "/tmp/cc-lb-e2e.db";
process.env.DB_PATH = dbPath;

for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

const { createAccount, updateAccount } = await import("../../src/db/accounts");
const { logRequest, updateRequestLogUsage } = await import("../../src/db/request-log");
const { patchSettings } = await import("../../src/db/settings");

const now = Date.now();

const primary = createAccount({
  name: "Primary healthy",
  access_token: "primary-access",
  refresh_token: "primary-refresh",
  expires_at: now + 24 * 60 * 60 * 1000,
  refresh_token_issued_at: now - 10 * 24 * 60 * 60 * 1000,
  priority: 0,
});

const limited = createAccount({
  name: "Rate limited",
  access_token: "limited-access",
  refresh_token: "limited-refresh",
  expires_at: now + 24 * 60 * 60 * 1000,
  refresh_token_issued_at: now - 10 * 24 * 60 * 60 * 1000,
  priority: 1,
});

updateAccount(limited.id, {
  rate_limited_until: now + 5 * 60 * 1000,
  rate_limit_status: "rate_limited",
  rate_limit_remaining: 0,
  rate_limit_reset: now + 5 * 60 * 1000,
  consecutive_rate_limits: 1,
});

createAccount({
  name: "Needs reauth",
  access_token: null,
  refresh_token: null,
  expires_at: null,
  priority: 2,
});

updateAccount(primary.id, {
  request_count: 3,
  session_request_count: 2,
  last_used: now - 30_000,
  rate_limit_status: "ok",
  rate_limit_remaining: 84,
  rate_limit_reset: now + 30 * 60 * 1000,
});

const okLogId = logRequest({
  accountId: primary.id,
  ts: now - 20_000,
  status: 200,
  model: "claude-sonnet-e2e",
  outcome: "ok",
  method: "POST",
  path: "/v1/messages",
  latencyMs: 42,
  totalMs: 110,
});

updateRequestLogUsage(okLogId, {
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 200,
  cacheCreationTokens: 50,
  costUsd: 0.006,
  upstreamRequestId: "req_e2e_ok",
});

logRequest({
  accountId: limited.id,
  ts: now - 10_000,
  status: 429,
  model: "claude-haiku-e2e",
  outcome: "rate_limited",
  method: "POST",
  path: "/v1/messages/count_tokens",
  failoverAttempt: 1,
  latencyMs: 31,
  error: "rate limit from seeded e2e data",
});

patchSettings({
  strategy: "priority",
  stickySessions: true,
  stickyTtlMs: 5 * 60 * 60 * 1000,
  overloadRetryMax: 2,
});
