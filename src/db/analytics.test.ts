import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-analytics-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { createAccount, updateAccount } = await import("./accounts");
const { createApiKey } = await import("./api-keys");
const { getApiKeyAnalytics, getDashboardAnalytics, listApiKeyUsageSummaries } = await import("./analytics");
const { logRequest } = await import("./request-log");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("analytics repository", () => {
  test("aggregates dashboard and api key usage summaries", () => {
    const now = 9_000_000_000_000 + process.pid;
    const account = createAccount({ name: "Analytics A" });
    updateAccount(account.id, {
      rate_limit_status: "ok",
      rate_limit_remaining: 42,
      rate_limit_reset: now + 60 * 60 * 1000,
    });
    const otherAccount = createAccount({ name: "Analytics B" });
    const apiKey = createApiKey({ name: "Analytics key" }, now).apiKey;

    logRequest({
      accountId: account.id,
      apiKeyId: apiKey.id,
      ts: now - 60_000,
      status: 200,
      model: "claude-sonnet-4",
      outcome: "ok",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreationTokens: 2,
      costUsd: 0.01,
    });
    logRequest({
      accountId: account.id,
      apiKeyId: apiKey.id,
      ts: now - 30_000,
      status: 500,
      model: "claude-sonnet-4",
      outcome: "upstream_error",
      error: "boom",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.02,
    });
    logRequest({
      accountId: otherAccount.id,
      ts: now - 30_000,
      status: 200,
      model: "claude-haiku",
      outcome: "ok",
      inputTokens: 7,
      outputTokens: 8,
      costUsd: 0.03,
    });

    const dashboard = getDashboardAnalytics("1d", now);
    expect(dashboard.overview.requestCount).toBe(3);
    expect(dashboard.overview.tokenTotal).toBe(32);
    expect(dashboard.overview.cachedTokenTotal).toBe(5);
    expect(dashboard.overview.costUsd).toBeCloseTo(0.06);
    expect(dashboard.overview.errorCount).toBe(1);
    expect(dashboard.overview.topError).toEqual({ label: "boom", count: 1 });
    expect(dashboard.creditApproximations.fiveHourRemaining).toBe(42);
    expect(dashboard.accountSummaries.find((summary) => summary.accountId === account.id)?.requestCount).toBe(2);

    const byKey = listApiKeyUsageSummaries(now - 24 * 60 * 60 * 1000, now);
    expect(byKey[apiKey.id]?.requestCount).toBe(2);
    expect(byKey[apiKey.id]?.tokenTotal).toBe(17);

    const keyAnalytics = getApiKeyAnalytics(apiKey.id, "7d", now);
    expect(keyAnalytics.overview.requestCount).toBe(2);
    expect(keyAnalytics.usageByAccount7d.find((summary) => summary.accountId === account.id)?.costUsd).toBeCloseTo(0.03);
    expect(keyAnalytics.usageByAccount7d.find((summary) => summary.accountId === otherAccount.id)?.requestCount).toBe(0);
  });
});
