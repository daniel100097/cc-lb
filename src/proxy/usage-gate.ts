// Account-wide utilization for the new-session gate, read from the stored
// /usage snapshot (accounts.usage_windows JSON, written by the account probe).
// Considers the 5h session window and the weekly all-models window; weekly
// model-scoped windows are ignored since they don't block the whole account.

/**
 * Highest used percent across the account-wide windows, or null when unknown:
 * no snapshot, no gated window, no percent, or the snapshot predates the
 * current window (its reset time already passed).
 */
export function gatedUsedPercent(usageWindows: string | null, now: number): number | null {
  if (!usageWindows) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(usageWindows);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  let max: number | null = null;
  for (const window of parsed) {
    if (!isRecord(window)) continue;
    if (window.kind !== "session" && window.kind !== "week_all_models") continue;
    if (typeof window.usedPercent !== "number") continue;
    const resetsAtMs = typeof window.resetsAtMs === "number" ? window.resetsAtMs : null;
    if (resetsAtMs !== null && resetsAtMs <= now) continue;
    if (max === null || window.usedPercent > max) max = window.usedPercent;
  }
  return max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
