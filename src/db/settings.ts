import { orm } from "./client";
import { settings as settingsTable } from "./schema";

export interface Settings {
  strategy: string;
  apiKeyAuthEnabled: boolean;
  rawHttpLoggingEnabled: boolean;
  rateLimitBackoffBaseMs: number;
  rateLimitBackoffMaxMs: number;
  sessionDurationMs: number;
  overloadRetryMax: number;
  /** Accounts at/above this % of the 5h session or weekly window get no new chats. */
  newSessionUsageCutoffPercent: number;
  /** Remove forwarded-for/via/real-ip headers before sending upstream. */
  stripForwardedHeaders: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  strategy: "priority",
  apiKeyAuthEnabled: false,
  rawHttpLoggingEnabled: false,
  rateLimitBackoffBaseMs: 30_000,
  rateLimitBackoffMaxMs: 5 * 60 * 1000,
  sessionDurationMs: 5 * 60 * 60 * 1000,
  overloadRetryMax: 2,
  newSessionUsageCutoffPercent: 95,
  stripForwardedHeaders: false,
};

export function getSettings(): Settings {
  const stored = Object.fromEntries(orm.select().from(settingsTable).all().map((row) => [row.key, row.value]));
  return {
    strategy: stored.strategy ?? DEFAULT_SETTINGS.strategy,
    apiKeyAuthEnabled:
      stored.apiKeyAuthEnabled === undefined
        ? DEFAULT_SETTINGS.apiKeyAuthEnabled
        : stored.apiKeyAuthEnabled === "true",
    rawHttpLoggingEnabled:
      stored.rawHttpLoggingEnabled === undefined
        ? DEFAULT_SETTINGS.rawHttpLoggingEnabled
        : stored.rawHttpLoggingEnabled === "true",
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
    newSessionUsageCutoffPercent: toStoredNumber(
      stored.newSessionUsageCutoffPercent,
      DEFAULT_SETTINGS.newSessionUsageCutoffPercent,
    ),
    stripForwardedHeaders:
      stored.stripForwardedHeaders === undefined
        ? DEFAULT_SETTINGS.stripForwardedHeaders
        : stored.stripForwardedHeaders === "true",
  };
}

export function patchSettings(patch: Partial<Settings>): Settings {
  if (patch.strategy !== undefined) upsertSetting("strategy", patch.strategy);
  if (patch.apiKeyAuthEnabled !== undefined) upsertSetting("apiKeyAuthEnabled", String(patch.apiKeyAuthEnabled));
  if (patch.rawHttpLoggingEnabled !== undefined) {
    upsertSetting("rawHttpLoggingEnabled", String(patch.rawHttpLoggingEnabled));
  }
  if (patch.rateLimitBackoffBaseMs !== undefined) {
    upsertSetting("rateLimitBackoffBaseMs", String(patch.rateLimitBackoffBaseMs));
  }
  if (patch.rateLimitBackoffMaxMs !== undefined) {
    upsertSetting("rateLimitBackoffMaxMs", String(patch.rateLimitBackoffMaxMs));
  }
  if (patch.sessionDurationMs !== undefined) upsertSetting("sessionDurationMs", String(patch.sessionDurationMs));
  if (patch.overloadRetryMax !== undefined) upsertSetting("overloadRetryMax", String(patch.overloadRetryMax));
  if (patch.newSessionUsageCutoffPercent !== undefined) {
    upsertSetting("newSessionUsageCutoffPercent", String(patch.newSessionUsageCutoffPercent));
  }
  if (patch.stripForwardedHeaders !== undefined) {
    upsertSetting("stripForwardedHeaders", String(patch.stripForwardedHeaders));
  }
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
