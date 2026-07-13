import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Account } from "../db/accounts";

const root = `/tmp/cc-lb-token-manager-${process.pid}`;
process.env.CLAUDE_ACCOUNTS_DIR = root;

// Mock the probe so no CLI/tmux is spawned; drive its behavior per test.
const probeAccount = mock(async (_id: string, _trigger: string) => ({ outcome: "refreshed", usage: null }));
// Bare call on purpose: bun applies the mock synchronously, and a top-level
// await here would suspend this module's evaluation and let other test files
// interleave. Typed void|Promise<void>, hence the void marker for the linter.
void mock.module("./account-probe", () => ({
  probeAccount,
  isProbeReauthRequiredError: (error: unknown) => error instanceof Error && error.name === "ProbeReauthRequiredError",
}));

const { seedAccountCredentials } = await import("../testing/seed-credentials");
const { accountConfigDir } = await import("./account-config");
const { getValidAccessToken } = await import("./token-manager");

function account(id: string): Account {
  return {
    id,
    name: id,
    auth_type: "oauth_refresh",
    created_at: 0,
    last_used: null,
    priority: 0,
    request_count: 0,
    session_start: null,
    session_request_count: 0,
    rate_limit_status: null,
    rate_limit_reset: null,
    rate_limit_remaining: null,
    rate_limit_5h_utilization: null,
    rate_limit_5h_reset: null,
    rate_limit_7d_utilization: null,
    rate_limit_7d_reset: null,
    rate_limited_until: null,
    consecutive_rate_limits: 0,
    needs_reauth: 0,
    paused: 0,
    pause_reason: null,
    usage_windows: null,
    usage_checked_at: null,
  };
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  probeAccount.mockClear();
  probeAccount.mockImplementation(async () => ({ outcome: "refreshed", usage: null }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("getValidAccessToken", () => {
  test("returns the file token without probing when comfortably valid", async () => {
    seedAccountCredentials("a", { accessToken: "fresh", expiresAt: Date.now() + 3_600_000 });
    expect(await getValidAccessToken(account("a"))).toBe("fresh");
    expect(probeAccount).not.toHaveBeenCalled();
  });

  test("serves the current token and kicks a background probe inside the safety window", async () => {
    seedAccountCredentials("b", { accessToken: "soon", expiresAt: Date.now() + 10 * 60_000 });
    expect(await getValidAccessToken(account("b"))).toBe("soon");
    await Promise.resolve();
    expect(probeAccount).toHaveBeenCalledTimes(1);
    expect(probeAccount.mock.calls[0]).toEqual(["b", "safety_window"]);
  });

  test("awaits a probe when expired, then returns the refreshed file token", async () => {
    seedAccountCredentials("c", { accessToken: "stale", expiresAt: Date.now() - 1_000 });
    probeAccount.mockImplementation(async (id: string) => {
      seedAccountCredentials(id, { accessToken: "refreshed-token", expiresAt: Date.now() + 3_600_000 });
      return { outcome: "refreshed", usage: null };
    });
    expect(await getValidAccessToken(account("c"))).toBe("refreshed-token");
    expect(probeAccount.mock.calls[0]).toEqual(["c", "expired"]);
  });

  test("probes when no credentials file exists yet", async () => {
    probeAccount.mockImplementation(async (id: string) => {
      seedAccountCredentials(id, { accessToken: "first-token", expiresAt: Date.now() + 3_600_000 });
      return { outcome: "refreshed", usage: null };
    });
    expect(await getValidAccessToken(account("d"))).toBe("first-token");
    expect(probeAccount.mock.calls[0]).toEqual(["d", "expired"]);
  });

  test("sets needs_reauth and rethrows on a reauth-required probe", async () => {
    seedAccountCredentials("e", { accessToken: "stale", expiresAt: Date.now() - 1_000 });
    probeAccount.mockImplementation(async () => {
      const error = new Error("dead refresh token");
      error.name = "ProbeReauthRequiredError";
      throw error;
    });
    const acct = account("e");
    await expect(getValidAccessToken(acct)).rejects.toThrow("dead refresh token");
    expect(acct.needs_reauth).toBe(1);
  });

  test("throws when the probe leaves no usable token", async () => {
    // expired file, probe succeeds but writes nothing new
    seedAccountCredentials("f", { accessToken: "stale", expiresAt: Date.now() - 1_000 });
    rmSync(accountConfigDir("f"), { recursive: true, force: true });
    probeAccount.mockImplementation(async () => ({ outcome: "valid_noop", usage: null }));
    await expect(getValidAccessToken(account("f"))).rejects.toThrow("no access token after refresh");
  });
});
