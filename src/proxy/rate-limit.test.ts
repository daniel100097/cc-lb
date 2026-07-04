import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

const dbPath = `/tmp/cc-lb-ratelimit-test-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${dbPath}${suffix}`, { force: true });
}
process.env.DB_PATH = dbPath;
const accountsDir = `/tmp/cc-lb-ratelimit-accounts-${process.pid}`;
process.env.CLAUDE_ACCOUNTS_DIR = accountsDir;

const { applyCooldown, MIN_COOLDOWN_FLOOR_MS, parseRateLimit, recordMetadata } = await import("./rate-limit");
const { createAccount, getAccount, updateAccount } = await import("../db/accounts");
const { DEFAULT_SETTINGS } = await import("../db/settings");
const { seedAccountCredentials } = await import("../testing/seed-credentials");

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  rmSync(accountsDir, { recursive: true, force: true });
});

const now = 1_800_000_000_000;

describe("parseRateLimit", () => {
  test("parses unified hard rate-limit headers", () => {
    const res = new Response("limited", {
      status: 200,
      headers: {
        "anthropic-ratelimit-unified-status": "rate_limited",
        "anthropic-ratelimit-unified-reset": String(Math.floor((now + 120_000) / 1000)),
        "anthropic-ratelimit-unified-remaining": "4",
      },
    });
    const info = parseRateLimit(res, now);
    expect(info.isRateLimited).toBe(true);
    expect(info.remaining).toBe(4);
    expect(info.resetTime).toBe(now + 120_000);
  });

  test("uses retry-after for overload responses", () => {
    const info = parseRateLimit(new Response("overload", { status: 529, headers: { "retry-after": "8" } }), now);
    expect(info.isRateLimited).toBe(true);
    expect(info.resetTime).toBe(now + 8_000);
  });

  test("uses retry-after HTTP dates", () => {
    const retryAt = new Date(now + 45_000).toUTCString();
    const info = parseRateLimit(new Response("limited", { status: 429, headers: { "retry-after": retryAt } }), now);
    expect(info.isRateLimited).toBe(true);
    expect(info.resetTime).toBe(Date.parse(retryAt));
  });

  test("uses x-ratelimit-reset when retry-after is missing", () => {
    const reset = Math.floor((now + 90_000) / 1000);
    const info = parseRateLimit(new Response("limited", { status: 429, headers: { "x-ratelimit-reset": String(reset) } }), now);
    expect(info.resetTime).toBe(reset * 1000);
  });

  test("clamps far future reset values to one day", () => {
    const reset = Math.floor((now + 48 * 60 * 60 * 1000) / 1000);
    const info = parseRateLimit(
      new Response("limited", {
        status: 429,
        headers: { "anthropic-ratelimit-unified-reset": String(reset) },
      }),
      now,
    );
    expect(info.resetTime).toBe(now + 24 * 60 * 60 * 1000);
  });

  test("does not invent a default cooldown for headerless overloads", () => {
    const info = parseRateLimit(new Response("overload", { status: 529 }), now);
    expect(info.isRateLimited).toBe(true);
    expect(info.resetTime).toBeNull();
  });

  test("uses default cooldown for headerless 429", () => {
    const info = parseRateLimit(new Response("limited", { status: 429 }), now);
    expect(info.isRateLimited).toBe(true);
    expect(info.resetTime).toBe(now + 60_000);
  });

  test("does not treat soft unified status as limited", () => {
    const info = parseRateLimit(
      new Response("ok", { status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed_warning" } }),
      now,
    );
    expect(info.isRateLimited).toBe(false);
  });

  test("flags out_of_credits on 429 with the overage-disabled-reason header", () => {
    const info = parseRateLimit(
      new Response("limited", {
        status: 429,
        headers: { "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits" },
      }),
      now,
    );
    expect(info.isRateLimited).toBe(true);
    expect(info.outOfCredits).toBe(true);
  });

  test("does not flag out_of_credits on a plain 429", () => {
    const info = parseRateLimit(new Response("limited", { status: 429 }), now);
    expect(info.outOfCredits).toBe(false);
  });

  test("requires an exact case-sensitive out_of_credits value", () => {
    const info = parseRateLimit(
      new Response("limited", {
        status: 429,
        headers: { "anthropic-ratelimit-unified-overage-disabled-reason": "Out_Of_Credits" },
      }),
      now,
    );
    expect(info.outOfCredits).toBe(false);
  });

  test("ignores the out_of_credits header on non-429 responses", () => {
    const info = parseRateLimit(
      new Response("ok", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-status": "allowed_warning",
          "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
        },
      }),
      now,
    );
    expect(info.outOfCredits).toBe(false);
  });

  test("parses per-window utilization headers", () => {
    // Header shape captured from a live /v1/messages response (2026-07).
    const info = parseRateLimit(
      new Response("ok", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-reset": String(Math.floor((now + 3_600_000) / 1000)),
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-reset": String(Math.floor((now + 3_600_000) / 1000)),
          "anthropic-ratelimit-unified-5h-utilization": "0.16",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 6 * 24 * 3_600_000) / 1000)),
          "anthropic-ratelimit-unified-7d-utilization": "0.11",
        },
      }),
      now,
    );
    expect(info.fiveHour.utilization).toBe(0.16);
    expect(info.fiveHour.reset).toBe(now + 3_600_000);
    expect(info.sevenDay.utilization).toBe(0.11);
    expect(info.sevenDay.reset).toBe(now + 6 * 24 * 3_600_000);
    expect(info.remaining).toBeNull();
  });

  test("clamps utilization to [0,1] and ignores garbage values", () => {
    const info = parseRateLimit(
      new Response("ok", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "1.7",
          "anthropic-ratelimit-unified-7d-utilization": "not-a-number",
        },
      }),
      now,
    );
    expect(info.fiveHour.utilization).toBe(1);
    expect(info.sevenDay.utilization).toBeNull();
  });

  test("reports null windows when the headers are absent", () => {
    const info = parseRateLimit(new Response("ok", { status: 200 }), now);
    expect(info.fiveHour).toEqual({ utilization: null, reset: null });
    expect(info.sevenDay).toEqual({ utilization: null, reset: null });
  });
});

describe("applyCooldown", () => {
  let accountSeq = 0;
  function makeAccount(overrides: { consecutive_rate_limits?: number } = {}) {
    accountSeq += 1;
    const account = createAccount({
      name: `Cooldown ${process.pid}-${accountSeq}`,
    });
    seedAccountCredentials(account.id, {
      accessToken: `cooldown-access-${accountSeq}`,
      refreshToken: `cooldown-refresh-${accountSeq}`,
      expiresAt: now + 3_600_000,
    });
    if (overrides.consecutive_rate_limits !== undefined) {
      updateAccount(account.id, { consecutive_rate_limits: overrides.consecutive_rate_limits });
      const reloaded = getAccount(account.id);
      if (!reloaded) throw new Error("account vanished");
      return reloaded;
    }
    return account;
  }

  const noWindow = { utilization: null, reset: null };
  const baseInfo = {
    isRateLimited: true,
    status: "rate_limited",
    remaining: 0,
    fiveHour: noWindow,
    sevenDay: noWindow,
    outOfCredits: false,
  };

  test("never cools shorter than the upstream reset", () => {
    const account = makeAccount();
    applyCooldown(account, { ...baseInfo, resetTime: now + 600_000 }, DEFAULT_SETTINGS, now);
    expect(account.rate_limited_until).toBe(now + 600_000);
    expect(getAccount(account.id)?.rate_limited_until).toBe(now + 600_000);
  });

  test("floors short upstream resets to the minimum cooldown", () => {
    const account = makeAccount();
    applyCooldown(account, { ...baseInfo, resetTime: now + 5_000 }, DEFAULT_SETTINGS, now);
    expect(account.rate_limited_until).toBe(now + MIN_COOLDOWN_FLOOR_MS);
  });

  test("uses base backoff when no reset is known", () => {
    const account = makeAccount();
    applyCooldown(account, { ...baseInfo, resetTime: null }, DEFAULT_SETTINGS, now);
    expect(account.rate_limited_until).toBe(now + DEFAULT_SETTINGS.rateLimitBackoffBaseMs);
    expect(account.consecutive_rate_limits).toBe(1);
  });

  test("doubles backoff with the consecutive counter", () => {
    const account = makeAccount({ consecutive_rate_limits: 1 });
    applyCooldown(account, { ...baseInfo, resetTime: null }, DEFAULT_SETTINGS, now);
    expect(account.rate_limited_until).toBe(now + DEFAULT_SETTINGS.rateLimitBackoffBaseMs * 2);
  });

  test("caps backoff at the configured maximum", () => {
    const account = makeAccount({ consecutive_rate_limits: 10 });
    applyCooldown(account, { ...baseInfo, resetTime: null }, DEFAULT_SETTINGS, now);
    expect(account.rate_limited_until).toBe(now + DEFAULT_SETTINGS.rateLimitBackoffMaxMs);
  });

  test("persists counter and metadata on the reset path", () => {
    const account = makeAccount();
    applyCooldown(account, { ...baseInfo, resetTime: now + 600_000 }, DEFAULT_SETTINGS, now);
    applyCooldown(account, { ...baseInfo, resetTime: now + 600_000 }, DEFAULT_SETTINGS, now);
    const stored = getAccount(account.id);
    expect(stored?.consecutive_rate_limits).toBe(2);
    expect(stored?.rate_limit_status).toBe("rate_limited");
    expect(stored?.rate_limit_reset).toBe(now + 600_000);
    expect(stored?.rate_limit_remaining).toBe(0);
  });
});

describe("recordMetadata", () => {
  const noWindow = { utilization: null, reset: null };

  test("persists per-window utilization", () => {
    const account = createAccount({ name: `Windows ${process.pid}-a` });
    recordMetadata(account, {
      isRateLimited: false,
      status: "allowed",
      resetTime: now + 3_600_000,
      remaining: null,
      fiveHour: { utilization: 0.16, reset: now + 3_600_000 },
      sevenDay: { utilization: 0.11, reset: now + 6 * 24 * 3_600_000 },
      outOfCredits: false,
    });
    const stored = getAccount(account.id);
    expect(stored?.rate_limit_5h_utilization).toBe(0.16);
    expect(stored?.rate_limit_5h_reset).toBe(now + 3_600_000);
    expect(stored?.rate_limit_7d_utilization).toBe(0.11);
    expect(stored?.rate_limit_7d_reset).toBe(now + 6 * 24 * 3_600_000);
  });

  test("keeps prior window data when a response omits the headers", () => {
    const account = createAccount({ name: `Windows ${process.pid}-b` });
    recordMetadata(account, {
      isRateLimited: false,
      status: "allowed",
      resetTime: null,
      remaining: null,
      fiveHour: { utilization: 0.5, reset: now + 3_600_000 },
      sevenDay: { utilization: 0.2, reset: now + 6 * 24 * 3_600_000 },
      outOfCredits: false,
    });
    recordMetadata(account, {
      isRateLimited: false,
      status: "allowed",
      resetTime: null,
      remaining: null,
      fiveHour: noWindow,
      sevenDay: noWindow,
      outOfCredits: false,
    });
    const stored = getAccount(account.id);
    expect(stored?.rate_limit_5h_utilization).toBe(0.5);
    expect(stored?.rate_limit_7d_utilization).toBe(0.2);
  });
});
