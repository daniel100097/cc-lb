import { db } from "./client";

export interface Settings {
  strategy: string;
  stickySessions: boolean;
  stickyTtlMs: number;
  rateLimitBackoffBaseMs: number;
  rateLimitBackoffMaxMs: number;
  sessionDurationMs: number;
  overloadRetryMax: number;
}

export const DEFAULT_SETTINGS: Settings = {
  strategy: "priority",
  stickySessions: true,
  stickyTtlMs: 5 * 60 * 60 * 1000,
  rateLimitBackoffBaseMs: 30_000,
  rateLimitBackoffMaxMs: 5 * 60 * 1000,
  sessionDurationMs: 5 * 60 * 60 * 1000,
  overloadRetryMax: 2,
};

const selectAll = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings");
const upsert = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function getSettings(): Settings {
  const stored = Object.fromEntries(selectAll.all().map((r) => [r.key, r.value]));
  return {
    strategy: stored.strategy ?? DEFAULT_SETTINGS.strategy,
    stickySessions:
      stored.stickySessions === undefined ? DEFAULT_SETTINGS.stickySessions : stored.stickySessions === "true",
    stickyTtlMs: toStoredNumber(stored.stickyTtlMs, DEFAULT_SETTINGS.stickyTtlMs),
    rateLimitBackoffBaseMs: toStoredNumber(
      stored.rateLimitBackoffBaseMs,
      DEFAULT_SETTINGS.rateLimitBackoffBaseMs,
    ),
    rateLimitBackoffMaxMs: toStoredNumber(
      stored.rateLimitBackoffMaxMs,
      DEFAULT_SETTINGS.rateLimitBackoffMaxMs,
    ),
    sessionDurationMs: toStoredNumber(stored.sessionDurationMs, DEFAULT_SETTINGS.sessionDurationMs),
    overloadRetryMax: toStoredNumber(stored.overloadRetryMax, DEFAULT_SETTINGS.overloadRetryMax),
  };
}

export function patchSettings(patch: Partial<Settings>): Settings {
  if (patch.strategy !== undefined) upsert.run("strategy", patch.strategy);
  if (patch.stickySessions !== undefined) upsert.run("stickySessions", String(patch.stickySessions));
  if (patch.stickyTtlMs !== undefined) upsert.run("stickyTtlMs", String(patch.stickyTtlMs));
  if (patch.rateLimitBackoffBaseMs !== undefined) {
    upsert.run("rateLimitBackoffBaseMs", String(patch.rateLimitBackoffBaseMs));
  }
  if (patch.rateLimitBackoffMaxMs !== undefined) {
    upsert.run("rateLimitBackoffMaxMs", String(patch.rateLimitBackoffMaxMs));
  }
  if (patch.sessionDurationMs !== undefined) upsert.run("sessionDurationMs", String(patch.sessionDurationMs));
  if (patch.overloadRetryMax !== undefined) upsert.run("overloadRetryMax", String(patch.overloadRetryMax));
  return getSettings();
}

function toStoredNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
