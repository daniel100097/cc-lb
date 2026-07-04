import { describe, expect, test } from "bun:test";
import { parseResetTime, parseUsagePanel, type UsageWindow, usagePanelVisible } from "./usage-panel";

function at(windows: UsageWindow[], index: number): UsageWindow {
  const window = windows[index];
  if (!window) throw new Error(`no window at index ${index}`);
  return window;
}

// Exact capture from a real /usage panel.
const PANEL = `   Settings  Status   Config   Usage   Stats

   Session

   Total cost:            $0.0210
   Total duration (API):  3s
   Total duration (wall): 10s
   Total code changes:    0 lines added, 0 lines removed
   Usage by model:
       claude-haiku-4-5:  10 input, 176 output, 19.3k cache read, 9.1k cache write ($0.0210)

   Current session
                                                      0% used
   Resets 3:59pm (Europe/Berlin)

   Current week (all models)
   ██████████████████                                 36% used
   Resets Jul 5, 1:59pm (Europe/Berlin)

   Current week (Fable)
   ████████████████████████████████▌                  65% used
   Resets Jul 5, 1:59pm (Europe/Berlin)

   What's contributing to your limits usage?
   Approximate, based on local sessions on this machine — does not include other devices or claude.ai`;

// 2026-07-04T12:00:00Z — before both the 3:59pm and Jul 5 resets.
const NOW = Date.UTC(2026, 6, 4, 12, 0, 0);

describe("parseUsagePanel", () => {
  test("parses the three windows from the golden panel", () => {
    const snapshot = parseUsagePanel(PANEL, NOW);
    expect(snapshot.capturedAt).toBe(NOW);
    expect(snapshot.windows).toHaveLength(3);

    expect(at(snapshot.windows, 0)).toMatchObject({ kind: "session", model: null, usedPercent: 0, resetsRaw: "3:59pm (Europe/Berlin)" });
    expect(at(snapshot.windows, 1)).toMatchObject({ kind: "week_all_models", model: null, usedPercent: 36 });
    expect(at(snapshot.windows, 2)).toMatchObject({ kind: "week_model", model: "Fable", usedPercent: 65 });
  });

  test("session reset (bare wall time) resolves to next occurrence in tz", () => {
    const session = at(parseUsagePanel(PANEL, NOW).windows, 0);
    // 3:59pm Europe/Berlin = 13:59Z (CEST, UTC+2) on 2026-07-04 — later today.
    expect(session.resetsAtMs).toBe(Date.UTC(2026, 6, 4, 13, 59, 0));
  });

  test("dated reset resolves with the current year", () => {
    const weekAll = at(parseUsagePanel(PANEL, NOW).windows, 1);
    // Jul 5 1:59pm Europe/Berlin = 11:59Z.
    expect(weekAll.resetsAtMs).toBe(Date.UTC(2026, 6, 5, 11, 59, 0));
  });

  test("bare wall time already passed today rolls to tomorrow", () => {
    // now = 2026-07-04 20:00Z; 3:59pm Berlin (13:59Z) already passed → next is tomorrow.
    const lateNow = Date.UTC(2026, 6, 4, 20, 0, 0);
    const session = at(parseUsagePanel(PANEL, lateNow).windows, 0);
    expect(session.resetsAtMs).toBe(Date.UTC(2026, 6, 5, 13, 59, 0));
  });

  test("missing sections yield partial windows without throwing", () => {
    const partial = "Current session\n   50% used\n";
    const snapshot = parseUsagePanel(partial, NOW);
    expect(snapshot.windows).toHaveLength(1);
    expect(at(snapshot.windows, 0)).toMatchObject({ kind: "session", usedPercent: 50, resetsRaw: null, resetsAtMs: null });
  });

  test("no panel present yields empty windows", () => {
    expect(parseUsagePanel("nothing here", NOW).windows).toEqual([]);
    expect(parseUsagePanel("", NOW).windows).toEqual([]);
  });

  test("clamps and rounds odd percent values", () => {
    const text = "Current session\n  150% used\n\nCurrent week (all models)\n  36.7% used\n";
    const windows = parseUsagePanel(text, NOW).windows;
    expect(at(windows, 0).usedPercent).toBe(100);
    expect(at(windows, 1).usedPercent).toBe(37);
  });

  test("malformed timezone keeps resetsRaw but nulls the epoch", () => {
    const text = "Current session\n  0% used\nResets soon-ish\n";
    const session = at(parseUsagePanel(text, NOW).windows, 0);
    expect(session.resetsRaw).toBe("soon-ish");
    expect(session.resetsAtMs).toBeNull();
  });

  test("duplicate panels in scrollback: last one wins", () => {
    const stale = PANEL.replace("36% used", "10% used");
    const combined = `${stale}\n\n${PANEL}`;
    const weekAll = at(parseUsagePanel(combined, NOW).windows, 1);
    expect(weekAll.usedPercent).toBe(36);
  });
});

describe("usagePanelVisible", () => {
  test("true once the panel with a percent is on screen", () => {
    expect(usagePanelVisible(PANEL)).toBe(true);
  });
  test("false before the panel renders", () => {
    expect(usagePanelVisible("Welcome back\n> ")).toBe(false);
  });
});

describe("parseResetTime", () => {
  test("returns null when no timezone present", () => {
    expect(parseResetTime("3:59pm", NOW)).toBeNull();
  });
});
