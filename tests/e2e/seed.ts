import { rmSync } from "node:fs";

const dbPath = process.env.DB_PATH ?? "/tmp/cc-lb-e2e.db";
process.env.DB_PATH = dbPath;
// Seed and the e2e server run as separate processes and neither is passed
// CLAUDE_ACCOUNTS_DIR, so both fall back to the same ./data/claude-accounts
// root — write the seeded credentials where the server will read them.
const accountsDir = process.env.CLAUDE_ACCOUNTS_DIR ?? "./data/claude-accounts";
process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;

for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}

const { createAccount, updateAccount } = await import("../../src/db/accounts");
const { logRequest, updateRequestLogUsage } = await import("../../src/db/request-log");
const { patchSettings } = await import("../../src/db/settings");
const { seedAccountCredentials } = await import("../../src/testing/seed-credentials");

const now = Date.now();

const primary = createAccount({
  name: "Primary healthy",
  priority: 0,
});
seedAccountCredentials(primary.id, {
  accessToken: "primary-access",
  refreshToken: "primary-refresh",
  expiresAt: now + 24 * 60 * 60 * 1000,
});

const limited = createAccount({
  name: "Rate limited",
  priority: 1,
});
seedAccountCredentials(limited.id, {
  accessToken: "limited-access",
  refreshToken: "limited-refresh",
  expiresAt: now + 24 * 60 * 60 * 1000,
});

updateAccount(limited.id, {
  rate_limited_until: now + 5 * 60 * 1000,
  rate_limit_status: "rate_limited",
  rate_limit_remaining: 0,
  rate_limit_reset: now + 5 * 60 * 1000,
  consecutive_rate_limits: 1,
});

// No credentials file is seeded for this account: the server derives
// "needs_reauth" from the missing credentials, and the explicit flag keeps it
// out of the available pool.
const needsReauth = createAccount({
  name: "Needs reauth",
  priority: 2,
});
updateAccount(needsReauth.id, { needs_reauth: 1 });

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
