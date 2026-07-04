import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { orm } from "./client";
import { accounts as accountsTable } from "./schema";

export type AccountAuthType = "oauth_refresh" | "claude_code_oauth_token";

export interface Account {
  id: string;
  name: string;
  auth_type: AccountAuthType;
  device_id_override: string | null;
  created_at: number;
  last_used: number | null;
  priority: number;
  request_count: number;
  session_start: number | null;
  session_request_count: number;
  rate_limit_status: string | null;
  rate_limit_reset: number | null;
  rate_limit_remaining: number | null;
  rate_limited_until: number | null;
  consecutive_rate_limits: number;
  needs_reauth: number;
  paused: number;
  pause_reason: string | null;
  usage_windows: string | null;
  usage_checked_at: number | null;
}

export interface NewAccount {
  name: string;
  auth_type?: AccountAuthType;
  device_id_override?: string | null;
  priority?: number;
}

export type AccountPatch = Partial<Omit<Account, "id">>;
type AccountRow = typeof accountsTable.$inferSelect;

export function listAccounts(): Account[] {
  return orm
    .select()
    .from(accountsTable)
    .orderBy(asc(accountsTable.priority), asc(accountsTable.createdAt))
    .all()
    .map(toAccount);
}

export function getAccount(id: string): Account | null {
  const row = orm.select().from(accountsTable).where(eq(accountsTable.id, id)).get();
  return row ? toAccount(row) : null;
}

export function createAccount(a: NewAccount): Account {
  const id = randomUUID();
  const now = Date.now();
  const inserted = orm
    .insert(accountsTable)
    .values({
      id,
      name: a.name,
      authType: a.auth_type ?? "oauth_refresh",
      deviceIdOverride: a.device_id_override ?? null,
      createdAt: now,
      priority: a.priority ?? 0,
    })
    .returning()
    .get();
  if (!inserted) throw new Error("account insert failed");
  return toAccount(inserted);
}

export function updateAccount(id: string, patch: AccountPatch): void {
  const values: AccountUpdateValues = {};
  const add = <K extends keyof AccountUpdateValues>(key: K, value: AccountUpdateValues[K] | undefined) => {
    if (value === undefined) return;
    values[key] = value;
  };

  add("name", patch.name);
  add("authType", patch.auth_type);
  add("deviceIdOverride", patch.device_id_override);
  add("createdAt", patch.created_at);
  add("lastUsed", patch.last_used);
  add("priority", patch.priority);
  add("requestCount", patch.request_count);
  add("sessionStart", patch.session_start);
  add("sessionRequestCount", patch.session_request_count);
  add("rateLimitStatus", patch.rate_limit_status);
  add("rateLimitReset", patch.rate_limit_reset);
  add("rateLimitRemaining", patch.rate_limit_remaining);
  add("rateLimitedUntil", patch.rate_limited_until);
  add("consecutiveRateLimits", patch.consecutive_rate_limits);
  add("needsReauth", patch.needs_reauth);
  add("paused", patch.paused);
  add("pauseReason", patch.pause_reason);
  add("usageWindows", patch.usage_windows);
  add("usageCheckedAt", patch.usage_checked_at);

  if (Object.keys(values).length === 0) return;
  orm.update(accountsTable).set(values).where(eq(accountsTable.id, id)).run();
}

export function deleteAccount(id: string): void {
  orm.delete(accountsTable).where(eq(accountsTable.id, id)).run();
}

export function bumpRequestCount(id: string, now: number): void {
  orm
    .update(accountsTable)
    .set({
      requestCount: sql`${accountsTable.requestCount} + 1`,
      sessionRequestCount: sql`${accountsTable.sessionRequestCount} + 1`,
      lastUsed: now,
    })
    .where(eq(accountsTable.id, id))
    .run();
}

interface AccountUpdateValues {
  name?: string;
  authType?: AccountAuthType;
  deviceIdOverride?: string | null;
  createdAt?: number;
  lastUsed?: number | null;
  priority?: number;
  requestCount?: number;
  sessionStart?: number | null;
  sessionRequestCount?: number;
  rateLimitStatus?: string | null;
  rateLimitReset?: number | null;
  rateLimitRemaining?: number | null;
  rateLimitedUntil?: number | null;
  consecutiveRateLimits?: number;
  needsReauth?: number;
  paused?: number;
  pauseReason?: string | null;
  usageWindows?: string | null;
  usageCheckedAt?: number | null;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    auth_type: isAccountAuthType(row.authType) ? row.authType : "oauth_refresh",
    device_id_override: row.deviceIdOverride,
    created_at: row.createdAt,
    last_used: row.lastUsed,
    priority: row.priority,
    request_count: row.requestCount,
    session_start: row.sessionStart,
    session_request_count: row.sessionRequestCount,
    rate_limit_status: row.rateLimitStatus,
    rate_limit_reset: row.rateLimitReset,
    rate_limit_remaining: row.rateLimitRemaining,
    rate_limited_until: row.rateLimitedUntil,
    consecutive_rate_limits: row.consecutiveRateLimits,
    needs_reauth: row.needsReauth,
    paused: row.paused,
    pause_reason: row.pauseReason,
    usage_windows: row.usageWindows,
    usage_checked_at: row.usageCheckedAt,
  };
}

function isAccountAuthType(value: string): value is AccountAuthType {
  return value === "oauth_refresh" || value === "claude_code_oauth_token";
}
