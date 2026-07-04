import { describe, expect, test } from "bun:test";
import { gatedUsedPercent } from "./usage-gate";

const NOW = 1_750_000_000_000;

function windows(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify(entries);
}

function usageWindow(
  kind: string,
  usedPercent: number | null,
  resetsAtMs: number | null,
  model: string | null = null,
): Record<string, unknown> {
  return { label: kind, kind, model, usedPercent, resetsRaw: null, resetsAtMs };
}

describe("gatedUsedPercent", () => {
  test("returns the 5h session window percent", () => {
    expect(gatedUsedPercent(windows([usageWindow("session", 72, NOW + 60_000)]), NOW)).toBe(72);
  });

  test("returns the weekly all-models percent", () => {
    expect(gatedUsedPercent(windows([usageWindow("week_all_models", 64, NOW + 60_000)]), NOW)).toBe(64);
  });

  test("returns the max of session and weekly windows", () => {
    const both = windows([
      usageWindow("session", 30, NOW + 60_000),
      usageWindow("week_all_models", 97, NOW + 60_000),
    ]);
    expect(gatedUsedPercent(both, NOW)).toBe(97);
  });

  test("ignores model-scoped weekly windows", () => {
    const modelScoped = windows([
      usageWindow("session", 10, NOW + 60_000),
      usageWindow("week_model", 99, NOW + 60_000, "Fable"),
    ]);
    expect(gatedUsedPercent(modelScoped, NOW)).toBe(10);
  });

  test("null for missing / invalid / non-array input", () => {
    expect(gatedUsedPercent(null, NOW)).toBeNull();
    expect(gatedUsedPercent("not json", NOW)).toBeNull();
    expect(gatedUsedPercent(JSON.stringify({ kind: "session" }), NOW)).toBeNull();
  });

  test("skips windows whose reset already passed", () => {
    const staleSession = windows([
      usageWindow("session", 96, NOW - 1),
      usageWindow("week_all_models", 40, NOW + 60_000),
    ]);
    expect(gatedUsedPercent(staleSession, NOW)).toBe(40);
    expect(gatedUsedPercent(windows([usageWindow("session", 96, NOW - 1)]), NOW)).toBeNull();
  });

  test("null when no gated window has a percent", () => {
    expect(gatedUsedPercent(windows([usageWindow("session", null, NOW + 60_000)]), NOW)).toBeNull();
  });

  test("percent without a reset time still counts", () => {
    expect(gatedUsedPercent(windows([usageWindow("session", 88, null)]), NOW)).toBe(88);
  });
});
