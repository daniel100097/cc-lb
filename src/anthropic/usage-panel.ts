// Parser for the Claude Code /usage panel (TUI text after ANSI stripping).
// Pinned to the observed layout:
//
//   Current session
//                                                      0% used
//   Resets 3:59pm (Europe/Berlin)
//
//   Current week (all models)
//   ██████████████████                                 36% used
//   Resets Jul 5, 1:59pm (Europe/Berlin)
//
//   Current week (Fable)
//   ████████████████████████████████▌                  65% used
//   Resets Jul 5, 1:59pm (Europe/Berlin)
//
// Never throws; anything unrecognized degrades to nulls / empty windows.

export interface UsageWindow {
  label: string;
  kind: "session" | "week_all_models" | "week_model" | "other";
  model: string | null;
  usedPercent: number | null;
  resetsRaw: string | null;
  resetsAtMs: number | null;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  capturedAt: number;
}

const SESSION_HEADER = "Current session";
const WEEK_HEADER_RE = /^Current week \((.+)\)$/;
const PERCENT_RE = /(\d{1,3}(?:[.,]\d+)?)\s*%\s*used/;
const RESETS_RE = /^Resets\s+(.+?)\s*$/;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function usagePanelVisible(cleanedOutput: string): boolean {
  return cleanedOutput.includes(SESSION_HEADER) && PERCENT_RE.test(cleanedOutput);
}

export function parseUsagePanel(cleanedOutput: string, now = Date.now()): UsageSnapshot {
  try {
    return { windows: parseWindows(cleanedOutput, now), capturedAt: now };
  } catch {
    return { windows: [], capturedAt: now };
  }
}

function parseWindows(cleanedOutput: string, now: number): UsageWindow[] {
  // Scrollback may hold older panels — parse only the last one.
  const start = cleanedOutput.lastIndexOf(SESSION_HEADER);
  if (start === -1) return [];
  const lines = cleanedOutput
    .slice(start)
    .split("\n")
    .map((line) => line.trim());

  const windows: UsageWindow[] = [];
  let current: UsageWindow | null = null;

  for (const line of lines) {
    const header = parseHeader(line);
    if (header) {
      current = header;
      windows.push(current);
      continue;
    }
    if (!current) continue;

    if (current.usedPercent === null) {
      const percent = PERCENT_RE.exec(line);
      if (percent?.[1]) {
        const value = Math.round(Number(percent[1].replace(",", ".")));
        current.usedPercent = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
        continue;
      }
    }
    if (current.resetsRaw === null) {
      const resets = RESETS_RE.exec(line);
      if (resets?.[1]) {
        current.resetsRaw = resets[1];
        current.resetsAtMs = parseResetTime(resets[1], now);
      }
    }
  }

  return windows;
}

function parseHeader(line: string): UsageWindow | null {
  if (line === SESSION_HEADER) {
    return { label: line, kind: "session", model: null, usedPercent: null, resetsRaw: null, resetsAtMs: null };
  }
  const week = WEEK_HEADER_RE.exec(line);
  if (week?.[1]) {
    const scope = week[1];
    return {
      label: line,
      kind: scope.toLowerCase() === "all models" ? "week_all_models" : "week_model",
      model: scope.toLowerCase() === "all models" ? null : scope,
      usedPercent: null,
      resetsRaw: null,
      resetsAtMs: null,
    };
  }
  return null;
}

/**
 * Best-effort epoch for strings like "3:59pm (Europe/Berlin)" (next occurrence
 * of that wall time) and "Jul 5, 1:59pm (Europe/Berlin)". Null on any doubt.
 */
export function parseResetTime(raw: string, now = Date.now()): number | null {
  try {
    const tzMatch = /\(([^)]+)\)\s*$/.exec(raw);
    if (!tzMatch?.[1]) return null;
    const timeZone = tzMatch[1];
    const rest = raw.slice(0, tzMatch.index).trim().replace(/,\s*/g, " ");

    const match = /^(?:([A-Za-z]{3,9})\s+(\d{1,2})\s+)?(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(rest);
    if (!match) return null;
    const [, monthName, dayRaw, hourRaw, minuteRaw, meridiem] = match;
    let hour = Number(hourRaw) % 12;
    if (meridiem?.toLowerCase() === "pm") hour += 12;
    const minute = Number(minuteRaw);

    const nowParts = zonedParts(now, timeZone);
    let target: { year: number; month: number; day: number };
    if (monthName !== undefined && dayRaw !== undefined) {
      const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
      if (month === undefined) return null;
      target = { year: nowParts.year, month, day: Number(dayRaw) };
    } else {
      target = { year: nowParts.year, month: nowParts.month, day: nowParts.day };
    }

    let epoch = zonedTimeToEpoch({ ...target, hour, minute }, timeZone);
    if (epoch === null) return null;
    if (monthName === undefined) {
      // Bare wall time: next occurrence.
      if (epoch <= now) {
        epoch = zonedTimeToEpoch(addDays({ ...target, hour, minute }, 1), timeZone);
      }
    } else if (epoch < now - 30 * 24 * 60 * 60 * 1000) {
      // Dated but far in the past: assume year rollover.
      epoch = zonedTimeToEpoch({ ...target, year: target.year + 1, hour, minute }, timeZone);
    }
    return epoch;
  } catch {
    return null;
  }
}

interface ZonedStamp {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function addDays(stamp: ZonedStamp, days: number): ZonedStamp {
  const rolled = new Date(Date.UTC(stamp.year, stamp.month, stamp.day + days));
  return { ...stamp, year: rolled.getUTCFullYear(), month: rolled.getUTCMonth(), day: rolled.getUTCDate() };
}

function zonedParts(epoch: number, timeZone: string): ZonedStamp {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter.formatToParts(new Date(epoch))) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** Wall time in an IANA zone → epoch ms, via a two-pass offset fix-point. */
function zonedTimeToEpoch(stamp: ZonedStamp, timeZone: string): number | null {
  const utcGuess = Date.UTC(stamp.year, stamp.month, stamp.day, stamp.hour, stamp.minute);
  let epoch = utcGuess;
  for (let i = 0; i < 2; i += 1) {
    const seen = zonedParts(epoch, timeZone);
    const seenUtc = Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
    epoch += utcGuess - seenUtc;
  }
  const check = zonedParts(epoch, timeZone);
  const matches =
    check.year === stamp.year &&
    check.month === stamp.month &&
    check.day === stamp.day &&
    check.hour === stamp.hour &&
    check.minute === stamp.minute;
  // DST-skipped wall times won't converge — accept ±1h drift rather than null:
  // the reset moment is approximate anyway.
  if (!matches) {
    const drift = Math.abs(
      Date.UTC(check.year, check.month, check.day, check.hour, check.minute) -
        Date.UTC(stamp.year, stamp.month, stamp.day, stamp.hour, stamp.minute),
    );
    if (drift > 60 * 60 * 1000) return null;
  }
  return epoch;
}
