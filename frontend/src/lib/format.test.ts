import { afterAll, describe, expect, test } from "bun:test";
import { compactNumber, currency, durationMs, latencyMs, relativeTime } from "./format";

const originalNow = Date.now;
Date.now = () => 1_800_000_000_000;

afterAll(() => {
  Date.now = originalNow;
});

describe("format helpers", () => {
  test("formats relative times", () => {
    expect(relativeTime(null)).toBe("Never");
    expect(relativeTime(1_800_000_300_000)).toBe("5m from now");
    expect(relativeTime(1_799_999_700_000)).toBe("5m ago");
  });

  test("formats compact numbers and durations", () => {
    expect(compactNumber(1_200)).toContain("1");
    expect(durationMs(30_000)).toBe("30 sec");
    expect(durationMs(30 * 60_000)).toBe("30 min");
    expect(durationMs(2 * 60 * 60_000)).toBe("2 hr");
  });

  test("formats latency and currency", () => {
    expect(latencyMs(null)).toBe("-");
    expect(latencyMs(250)).toBe("250 ms");
    expect(latencyMs(1500)).toBe("1.5 s");
    expect(currency(null)).toBe("-");
    expect(currency(0.004)).toContain("0.004");
  });
});
