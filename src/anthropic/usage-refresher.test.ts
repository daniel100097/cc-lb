import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Account } from "../db/accounts";

const dbPath = `/tmp/cc-lb-usage-refresher-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { ACTIVE_REFRESH_INTERVAL_MS, IDLE_REFRESH_INTERVAL_MS, usageJitterFactor, usageRefreshDue } = await import(
  "./usage-refresher"
);

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

const NOW = 1_750_000_000_000;

function account(overrides: Partial<Account>): Account {
  return {
    id: "acc-1",
    name: "A",
    auth_type: "oauth_refresh",
    device_id_override: null,
    created_at: 0,
    last_used: null,
    priority: 0,
    request_count: 0,
    session_start: null,
    session_request_count: 0,
    rate_limit_status: null,
    rate_limit_reset: null,
    rate_limit_remaining: null,
    rate_limited_until: null,
    consecutive_rate_limits: 0,
    needs_reauth: 0,
    paused: 0,
    pause_reason: null,
    usage_windows: null,
    usage_checked_at: null,
    ...overrides,
  };
}

describe("usageRefreshDue", () => {
  // Jitter keeps the effective interval within [0.85, 1.15) of the base, so
  // boundary fixtures sit outside that band.
  test("active account refreshes on the jittered 5min interval", () => {
    const active = { last_used: NOW - 60_000 };
    expect(
      usageRefreshDue(account({ ...active, usage_checked_at: NOW - 1.15 * ACTIVE_REFRESH_INTERVAL_MS }), NOW),
    ).toBe(true);
    expect(usageRefreshDue(account({ ...active, usage_checked_at: NOW - 2 * 60_000 }), NOW)).toBe(false);
  });

  test("idle account refreshes on the jittered 3h interval", () => {
    const idle = { last_used: NOW - 60 * 60_000 };
    expect(usageRefreshDue(account({ ...idle, usage_checked_at: NOW - 60 * 60_000 }), NOW)).toBe(false);
    expect(usageRefreshDue(account({ ...idle, usage_checked_at: NOW - 1.15 * IDLE_REFRESH_INTERVAL_MS }), NOW)).toBe(
      true,
    );
  });

  test("jitter factor is deterministic, bounded, and spreads accounts", () => {
    const ids = Array.from({ length: 50 }, (_value, i) => `account-${i}`);
    for (const id of ids) {
      const factor = usageJitterFactor(id);
      expect(factor).toBeGreaterThanOrEqual(0.85);
      expect(factor).toBeLessThan(1.15);
      expect(usageJitterFactor(id)).toBe(factor);
    }
    expect(new Set(ids.map(usageJitterFactor)).size).toBeGreaterThan(40);
  });

  test("never-checked account is due immediately", () => {
    expect(usageRefreshDue(account({}), NOW)).toBe(true);
  });

  test("paused and reauth accounts are never due", () => {
    expect(usageRefreshDue(account({ paused: 1 }), NOW)).toBe(false);
    expect(usageRefreshDue(account({ needs_reauth: 1 }), NOW)).toBe(false);
  });
});
