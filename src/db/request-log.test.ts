import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-request-log-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;
const accountsDir = `/tmp/cc-lb-request-log-accounts-${process.pid}`;
process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;

const { createAccount } = await import("./accounts");
const {
  listRequestModels,
  listRequestOutcomes,
  listRequests,
  logRequest,
  updateRequestLogUsage,
} = await import("./request-log");
const { seedAccountCredentials } = await import("../testing/seed-credentials");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  rmSync(accountsDir, { recursive: true, force: true });
});

describe("request log repository", () => {
  test("inserts, updates usage, joins account names, and filters", () => {
    const account = createAccount({
      name: "Primary",
    });
    seedAccountCredentials(account.id, {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60_000,
    });
    const now = 10_000_000_000_000 + process.pid;
    const id = logRequest({
      accountId: account.id,
      ts: now,
      status: 200,
      model: "claude-sonnet-4",
      outcome: "ok",
      method: "POST",
      path: "/v1/messages",
      failoverAttempt: 1,
      latencyMs: 12,
      rawRequestHeaders: "{\"method\":\"POST\"}",
      rawRequestBody: "{\"model\":\"claude-sonnet-4\"}",
      rawUpstreamRequestHeaders: "{\"authorization\":\"Bearer [redacted]\"}",
      rawUpstreamRequestBody: "{\"model\":\"claude-sonnet-4\",\"account_uuid\":\"patched\"}",
    });
    logRequest({
      accountId: null,
      ts: now - 1000,
      status: null,
      model: "claude-haiku",
      outcome: "network_error",
      method: "POST",
      path: "/v1/messages/count_tokens",
      error: "socket closed db-request-log-unique",
    });

    updateRequestLogUsage(id, {
      totalMs: 20,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      costUsd: 0.001,
      upstreamRequestId: "req_123",
      rawResponseHeaders: "{\"status\":200}",
      rawResponseBody: "{\"ok\":true}",
    });

    const page = listRequests({ limit: 10, offset: 0, accountId: account.id });
    expect(page.total).toBe(1);
    expect(page.entries[0]?.account_name).toBe("Primary");
    expect(page.entries[0]?.input_tokens).toBe(100);
    expect(page.entries[0]?.failover_attempt).toBe(1);
    expect(page.entries[0]?.upstream_request_id).toBe("req_123");
    expect(page.entries[0]?.raw_request_body).toContain("claude-sonnet-4");
    expect(page.entries[0]?.raw_upstream_request_headers).toContain("Bearer [redacted]");
    expect(page.entries[0]?.raw_upstream_request_body).toContain("patched");
    expect(page.entries[0]?.raw_response_body).toContain("ok");

    const searched = listRequests({ limit: 10, offset: 0, search: "db-request-log-unique" });
    expect(searched.total).toBe(1);
    expect(searched.entries[0]?.outcome).toBe("network_error");
    const matchingRecent = listRequests({ limit: 10, offset: 0, since: now - 10_000, until: now + 1 });
    expect(matchingRecent.total).toBe(2);
    expect(listRequestModels()).toContain("claude-sonnet-4");
    expect(listRequestOutcomes()).toContain("ok");
  });
});
