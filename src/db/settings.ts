import { orm } from "./client";
import { settings as settingsTable } from "./schema";

export interface Settings {
  strategy: string;
  stickySessions: boolean;
  stickyTtlMs: number;
  apiKeyAuthEnabled: boolean;
  rateLimitBackoffBaseMs: number;
  rateLimitBackoffMaxMs: number;
  sessionDurationMs: number;
  overloadRetryMax: number;
}

export const DEFAULT_SETTINGS: Settings = {
  strategy: "priority",
  stickySessions: true,
  stickyTtlMs: 5 * 60 * 60 * 1000,
  apiKeyAuthEnabled: false,
  rateLimitBackoffBaseMs: 30_000,
  rateLimitBackoffMaxMs: 5 * 60 * 1000,
  sessionDurationMs: 5 * 60 * 60 * 1000,
  overloadRetryMax: 2,
};

export function getSettings(): Settings {
  const stored = Object.fromEntries(orm.select().from(settingsTable).all().map((row) => [row.key, row.value]));
  return {
    strategy: stored.strategy ?? DEFAULT_SETTINGS.strategy,
    stickySessions:
      stored.stickySessions === undefined ? DEFAULT_SETTINGS.stickySessions : stored.stickySessions === "true",
    stickyTtlMs: toStoredNumber(stored.stickyTtlMs, DEFAULT_SETTINGS.stickyTtlMs),
    apiKeyAuthEnabled:
      stored.apiKeyAuthEnabled === undefined
        ? DEFAULT_SETTINGS.apiKeyAuthEnabled
        : stored.apiKeyAuthEnabled === "true",
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
  if (patch.strategy !== undefined) upsertSetting("strategy", patch.strategy);
  if (patch.stickySessions !== undefined) upsertSetting("stickySessions", String(patch.stickySessions));
  if (patch.stickyTtlMs !== undefined) upsertSetting("stickyTtlMs", String(patch.stickyTtlMs));
  if (patch.apiKeyAuthEnabled !== undefined) upsertSetting("apiKeyAuthEnabled", String(patch.apiKeyAuthEnabled));
  if (patch.rateLimitBackoffBaseMs !== undefined) {
    upsertSetting("rateLimitBackoffBaseMs", String(patch.rateLimitBackoffBaseMs));
  }
  if (patch.rateLimitBackoffMaxMs !== undefined) {
    upsertSetting("rateLimitBackoffMaxMs", String(patch.rateLimitBackoffMaxMs));
  }
  if (patch.sessionDurationMs !== undefined) upsertSetting("sessionDurationMs", String(patch.sessionDurationMs));
  if (patch.overloadRetryMax !== undefined) upsertSetting("overloadRetryMax", String(patch.overloadRetryMax));
  return getSettings();
}

function upsertSetting(key: string, value: string): void {
  orm
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
    .run();
}

function toStoredNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
