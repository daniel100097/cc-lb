import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-request-log-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { createAccount } = await import("./accounts");
const {
  countRequestsSince,
  listRequestModels,
  listRequestOutcomes,
  listRequests,
  logRequest,
  updateRequestLogUsage,
} = await import("./request-log");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("request log repository", () => {
  test("inserts, updates usage, joins account names, and filters", () => {
    const account = createAccount({
      name: "Primary",
      access_token: "access",
      refresh_token: "refresh",
      expires_at: Date.now() + 60_000,
      refresh_token_issued_at: Date.now(),
    });
    const now = Date.now() + 3_600_000;
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
    });

    const page = listRequests({ limit: 10, offset: 0, accountId: account.id });
    expect(page.total).toBe(1);
    expect(page.entries[0]?.account_name).toBe("Primary");
    expect(page.entries[0]?.input_tokens).toBe(100);
    expect(page.entries[0]?.failover_attempt).toBe(1);
    expect(page.entries[0]?.upstream_request_id).toBe("req_123");

    const searched = listRequests({ limit: 10, offset: 0, search: "db-request-log-unique" });
    expect(searched.total).toBe(1);
    expect(searched.entries[0]?.outcome).toBe("network_error");
    expect(countRequestsSince(now - 10_000)).toBe(2);
    expect(listRequestModels()).toContain("claude-sonnet-4");
    expect(listRequestOutcomes()).toContain("ok");
  });
});
