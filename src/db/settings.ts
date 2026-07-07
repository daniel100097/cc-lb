import { orm } from "./client";
import { settings as settingsTable } from "./schema";

export interface Settings {
  strategy: string;
  stickySessions: boolean;
  stickyTtlMs: number;
  /** Re-pin a sticky session to the failover account that served it; off keeps the pin on its original account. */
  stickySwitchOnError: boolean;
  apiKeyAuthEnabled: boolean;
  rawHttpLoggingEnabled: boolean;
  rateLimitBackoffBaseMs: number;
  rateLimitBackoffMaxMs: number;
  sessionDurationMs: number;
  overloadRetryMax: number;
  /** Accounts at/above this % of the 5h session or weekly window get no new sticky sessions. */
  newSessionUsageCutoffPercent: number;
  /** Sent upstream instead of the client's user-agent; empty passes the client value through, "auto" tracks the bundled Claude Code version. */
  userAgentOverride: string;
  /** Remove forwarded-for/via/real-ip headers before sending upstream. */
  stripForwardedHeaders: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  strategy: "priority",
  stickySessions: true,
  stickyTtlMs: 5 * 60 * 60 * 1000,
  stickySwitchOnError: true,
  apiKeyAuthEnabled: false,
  rawHttpLoggingEnabled: false,
  rateLimitBackoffBaseMs: 30_000,
  rateLimitBackoffMaxMs: 5 * 60 * 1000,
  sessionDurationMs: 5 * 60 * 60 * 1000,
  overloadRetryMax: 2,
  newSessionUsageCutoffPercent: 95,
  userAgentOverride: "",
  stripForwardedHeaders: false,
};

export function getSettings(): Settings {
  const stored = Object.fromEntries(orm.select().from(settingsTable).all().map((row) => [row.key, row.value]));
  return {
    strategy: stored.strategy ?? DEFAULT_SETTINGS.strategy,
    stickySessions:
      stored.stickySessions === undefined ? DEFAULT_SETTINGS.stickySessions : stored.stickySessions === "true",
    stickyTtlMs: toStoredNumber(stored.stickyTtlMs, DEFAULT_SETTINGS.stickyTtlMs),
    stickySwitchOnError:
      stored.stickySwitchOnError === undefined
        ? DEFAULT_SETTINGS.stickySwitchOnError
        : stored.stickySwitchOnError === "true",
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
    userAgentOverride: stored.userAgentOverride ?? DEFAULT_SETTINGS.userAgentOverride,
    stripForwardedHeaders:
      stored.stripForwardedHeaders === undefined
        ? DEFAULT_SETTINGS.stripForwardedHeaders
        : stored.stripForwardedHeaders === "true",
  };
}

export function patchSettings(patch: Partial<Settings>): Settings {
  if (patch.strategy !== undefined) upsertSetting("strategy", patch.strategy);
  if (patch.stickySessions !== undefined) upsertSetting("stickySessions", String(patch.stickySessions));
  if (patch.stickyTtlMs !== undefined) upsertSetting("stickyTtlMs", String(patch.stickyTtlMs));
  if (patch.stickySwitchOnError !== undefined) {
    upsertSetting("stickySwitchOnError", String(patch.stickySwitchOnError));
  }
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
  if (patch.userAgentOverride !== undefined) upsertSetting("userAgentOverride", patch.userAgentOverride.trim());
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
