import { afterAll, describe, expect, test } from "bun:test";
import { compactNumber, durationMs, relativeTime } from "./format";

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
    expect(durationMs(30 * 60_000)).toBe("30 min");
    expect(durationMs(2 * 60 * 60_000)).toBe("2 hr");
  });
});
