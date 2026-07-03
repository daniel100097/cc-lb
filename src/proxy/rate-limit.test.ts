import { describe, expect, test } from "bun:test";
import { parseRateLimit } from "./rate-limit";

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
});
