import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  authType: text("auth_type").notNull().default("oauth_refresh"),
  deviceIdOverride: text("device_id_override"),
  createdAt: integer("created_at").notNull(),
  lastUsed: integer("last_used"),
  priority: integer("priority").notNull().default(0),
  requestCount: integer("request_count").notNull().default(0),
  sessionStart: integer("session_start"),
  sessionRequestCount: integer("session_request_count").notNull().default(0),
  rateLimitStatus: text("rate_limit_status"),
  rateLimitReset: integer("rate_limit_reset"),
  rateLimitRemaining: integer("rate_limit_remaining"),
  rateLimitedUntil: integer("rate_limited_until"),
  consecutiveRateLimits: integer("consecutive_rate_limits").notNull().default(0),
  needsReauth: integer("needs_reauth").notNull().default(0),
  paused: integer("paused").notNull().default(0),
  pauseReason: text("pause_reason"),
  usageWindows: text("usage_windows"),
  usageCheckedAt: integer("usage_checked_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const stickySessions = sqliteTable("sticky_sessions", {
  key: text("key").primaryKey(),
  accountId: text("account_id").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: integer("expires_at"),
    allowedModels: text("allowed_models"),
    trafficClass: text("traffic_class").notNull().default("default"),
    accountScopeEnabled: integer("account_scope_enabled").notNull().default(0),
    assignedAccountIds: text("assigned_account_ids"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    uniqueIndex("idx_api_keys_hash").on(table.keyHash),
    uniqueIndex("idx_api_keys_prefix").on(table.prefix),
    index("idx_api_keys_status").on(table.status),
  ],
);

export const requestLog = sqliteTable(
  "request_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id"),
    apiKeyId: text("api_key_id"),
    ts: integer("ts").notNull(),
    status: integer("status"),
    model: text("model"),
    outcome: text("outcome"),
    method: text("method"),
    path: text("path"),
    failoverAttempt: integer("failover_attempt").notNull().default(0),
    latencyMs: integer("latency_ms"),
    totalMs: integer("total_ms"),
    error: text("error"),
    upstreamRequestId: text("upstream_request_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
    costUsd: real("cost_usd"),
  },
  (table) => [
    index("idx_request_log_ts").on(table.ts),
    index("idx_request_log_account_ts").on(table.accountId, table.ts),
    index("idx_request_log_api_key_ts").on(table.apiKeyId, table.ts),
    index("idx_request_log_outcome_ts").on(table.outcome, table.ts),
  ],
);

export const oauthSessions = sqliteTable(
  "oauth_sessions",
  {
    id: text("id").primaryKey(),
    verifier: text("verifier").notNull(),
    state: text("state").notNull(),
    accountId: text("account_id"),
    name: text("name"),
    priority: integer("priority").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_oauth_sessions_expires_at").on(table.expiresAt)],
);
