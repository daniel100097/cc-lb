import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: integer("expires_at"),
  refreshTokenIssuedAt: integer("refresh_token_issued_at"),
  scopes: text("scopes"),
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

export const requestLog = sqliteTable(
  "request_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id"),
    ts: integer("ts").notNull(),
    status: integer("status"),
    model: text("model"),
    outcome: text("outcome"),
  },
  (table) => [
    index("idx_request_log_ts").on(table.ts),
    index("idx_request_log_account_ts").on(table.accountId, table.ts),
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
