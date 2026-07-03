import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-router-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;

const { appRouter } = await import("./router");
const { createAccount, updateAccount } = await import("../db/accounts");

const caller = appRouter.createCaller({ req: new Request("http://cc-lb.test") });

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

describe("appRouter accounts", () => {
  test("returns public account status and token health", async () => {
    const now = Date.now();
    createAccount({
      name: "Healthy",
      access_token: "access-a",
      refresh_token: "refresh-a",
      expires_at: now + 3_600_000,
      priority: 0,
    });
    const limited = createAccount({
      name: "Rate limited",
      access_token: "access-b",
      refresh_token: "refresh-b",
      expires_at: now + 3_600_000,
      priority: 1,
    });
    updateAccount(limited.id, {
      rate_limited_until: now + 60_000,
      rate_limit_status: "rate_limited",
      rate_limit_remaining: 0,
      rate_limit_reset: now + 60_000,
    });
    createAccount({
      name: "Needs reauth",
      access_token: null,
      refresh_token: null,
      expires_at: null,
      priority: 2,
    });

    const accounts = await caller.accounts.list();
    expect(accounts.map((account) => account.name)).toEqual(["Healthy", "Rate limited", "Needs reauth"]);
    expect(accounts.find((account) => account.name === "Healthy")?.status).toBe("active");
    expect(accounts.find((account) => account.name === "Rate limited")?.status).toBe("rate_limited");
    const reauth = accounts.find((account) => account.name === "Needs reauth");
    expect(reauth?.status).toBe("needs_reauth");
    expect(reauth?.tokenHealth.requiresReauth).toBe(true);
  });

  test("stats count account states from public status mapping", async () => {
    const stats = await caller.stats();
    expect(stats.totalAccounts).toBe(3);
    expect(stats.availableAccounts).toBe(1);
    expect(stats.rateLimitedAccounts).toBe(1);
    expect(stats.needsReauthAccounts).toBe(1);
  });

  test("update toggles pause state and pause reason", async () => {
    const account = createAccount({
      name: "Pause me",
      access_token: "access-c",
      refresh_token: "refresh-c",
      expires_at: Date.now() + 3_600_000,
    });

    const paused = await caller.accounts.update({
      id: account.id,
      paused: true,
      pauseReason: "maintenance",
    });
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("maintenance");

    const resumed = await caller.accounts.update({ id: account.id, paused: false });
    expect(resumed.status).toBe("active");
    expect(resumed.pauseReason).toBeNull();
  });
});
