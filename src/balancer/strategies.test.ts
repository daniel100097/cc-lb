import { describe, expect, test } from "bun:test";
import { isStrategyName, selectAccount } from "./strategies";
import type { AccountState } from "./types";

function state(id: string, patch: Partial<AccountState>): AccountState {
  return {
    id,
    priority: 0,
    paused: false,
    needsReauth: false,
    rateLimitedUntil: null,
    rateLimitReset: null,
    rateLimitRemaining: null,
    requestCount: 0,
    sessionRequestCount: 0,
    sessionStart: null,
    lastUsed: null,
    consecutiveRateLimits: 0,
    ...patch,
  };
}

describe("balancer strategies", () => {
  test("priority chooses lowest priority then request count", () => {
    const pick = selectAccount("priority", [state("a", { priority: 1 }), state("b", { priority: 0 })], Date.now());
    expect(pick?.id).toBe("b");
  });

  test("round robin uses least recently used", () => {
    const pick = selectAccount("round_robin", [state("a", { lastUsed: 20 }), state("b", { lastUsed: 10 })], Date.now());
    expect(pick?.id).toBe("b");
  });

  test("least used chooses lowest session request count", () => {
    const pick = selectAccount("least_used", [state("a", { sessionRequestCount: 5 }), state("b", { sessionRequestCount: 2 })], Date.now());
    expect(pick?.id).toBe("b");
  });

  test("weighted random uses remaining quota as weight", () => {
    const originalRandom = Math.random;
    Math.random = function randomMock() {
      return 0.95;
    };
    try {
      const pick = selectAccount(
        "weighted_random",
        [state("a", { rateLimitRemaining: 1 }), state("b", { rateLimitRemaining: 100 })],
        Date.now(),
      );
      expect(pick?.id).toBe("b");
    } finally {
      Math.random = originalRandom;
    }
  });

  test("session reset drain chooses the soonest reset window", () => {
    const pick = selectAccount(
      "session_reset_drain",
      [
        state("a", { rateLimitReset: null }),
        state("b", { rateLimitReset: 1_800_000_100_000 }),
        state("c", { rateLimitReset: 1_800_000_050_000 }),
      ],
      Date.now(),
    );
    expect(pick?.id).toBe("c");
  });

  test("returns null for empty pools", () => {
    expect(selectAccount("priority", [], Date.now())).toBeNull();
    expect(selectAccount("weighted_random", [], Date.now())).toBeNull();
  });

  test("does not mutate the input pool", () => {
    const pool = [state("a", { priority: 2 }), state("b", { priority: 1 })];
    const before = pool.map((item) => `${item.id}:${item.priority}`).join(",");
    selectAccount("priority", pool, Date.now());
    expect(pool.map((item) => `${item.id}:${item.priority}`).join(",")).toBe(before);
  });

  test("strategy guard recognizes configured names", () => {
    expect(isStrategyName("priority")).toBe(true);
    expect(isStrategyName("bad")).toBe(false);
  });
});
