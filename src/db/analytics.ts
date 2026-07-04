import type { Account } from "./accounts";
import { listAccounts } from "./accounts";
import { db } from "./client";

export type AnalyticsRange = "1d" | "7d" | "30d";

export interface UsageSummary {
  requestCount: number;
  tokenTotal: number;
  cachedTokenTotal: number;
  inputTokenTotal: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** cache_read / (input + cache_read + cache_creation), 0..1. */
  cacheHitRate: number;
  costUsd: number;
  errorCount: number;
  errorRate: number;
  topError: { label: string; count: number } | null;
}

export interface TrendBucket extends UsageSummary {
  startTs: number;
}

export interface AccountCreditApproximation {
  accountId: string;
  accountName: string;
  rateLimitStatus: string | null;
  rateLimitRemaining: number | null;
  rateLimitReset: number | null;
  fiveHourRemaining: number | null;
  sevenDayRemaining: number | null;
}

export interface AccountUsageSummary extends UsageSummary {
  accountId: string | null;
  accountName: string | null;
  credit: AccountCreditApproximation | null;
}

export interface DashboardAnalytics {
  range: AnalyticsRange;
  since: number;
  until: number;
  bucketMs: number;
  overview: UsageSummary;
  trend: TrendBucket[];
  accountSummaries: AccountUsageSummary[];
  creditApproximations: {
    fiveHourRemaining: number | null;
    sevenDayRemaining: number | null;
    accounts: AccountCreditApproximation[];
  };
}

export interface ApiKeyAnalytics {
  apiKeyId: string;
  range: AnalyticsRange;
  since: number;
  until: number;
  bucketMs: number;
  overview: UsageSummary;
  trend: TrendBucket[];
  usageByAccount7d: AccountUsageSummary[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Nominal per-account credit budgets used to turn a utilization fraction into
// a credit count. Must match the donut totals in the frontend dashboard.
const FIVE_HOUR_CREDITS_PER_ACCOUNT = 3_000;
const SEVEN_DAY_CREDITS_PER_ACCOUNT = 100_800;

const TOKEN_EXPR = "COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)";
const CACHED_TOKEN_EXPR = "COALESCE(cache_read_tokens, 0) + COALESCE(cache_creation_tokens, 0)";
const ERROR_EXPR =
  "(COALESCE(outcome, '') NOT IN ('ok', 'telemetry') OR (status IS NOT NULL AND status >= 400))";
const USAGE_SUM_COLUMNS = `
  COALESCE(SUM(${TOKEN_EXPR}), 0) AS tokenTotal,
  COALESCE(SUM(${CACHED_TOKEN_EXPR}), 0) AS cachedTokenTotal,
  COALESCE(SUM(COALESCE(input_tokens, 0)), 0) AS inputTokenTotal,
  COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cacheReadTokens,
  COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cacheCreationTokens,
  COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS costUsd,
  COALESCE(SUM(CASE WHEN ${ERROR_EXPR} THEN 1 ELSE 0 END), 0) AS errorCount
`;

export function getDashboardAnalytics(range: AnalyticsRange, now = Date.now()): DashboardAnalytics {
  const { since, until, bucketMs } = rangeWindow(range, now);
  const accounts = listAccounts();
  const accountSummaries = getAccountUsageSummaries(since, until, accounts);
  const creditAccounts = accounts.map((account) => toCreditApproximation(account, now));

  return {
    range,
    since,
    until,
    bucketMs,
    overview: getUsageSummary(since, until),
    trend: getTrendBuckets(since, until, bucketMs),
    accountSummaries,
    creditApproximations: {
      fiveHourRemaining: sumNullable(creditAccounts.map((account) => account.fiveHourRemaining)),
      sevenDayRemaining: sumNullable(creditAccounts.map((account) => account.sevenDayRemaining)),
      accounts: creditAccounts,
    },
  };
}

export function getApiKeyAnalytics(
  apiKeyId: string,
  range: AnalyticsRange,
  now = Date.now(),
): ApiKeyAnalytics {
  const { since, until, bucketMs } = rangeWindow(range, now);
  return {
    apiKeyId,
    range,
    since,
    until,
    bucketMs,
    overview: getUsageSummary(since, until, apiKeyId),
    trend: getTrendBuckets(since, until, bucketMs, apiKeyId),
    usageByAccount7d: getAccountUsageSummaries(now - SEVEN_DAYS_MS, now, listAccounts(), apiKeyId),
  };
}

export function listApiKeyUsageSummaries(
  since = Date.now() - THIRTY_DAYS_MS,
  until = Date.now(),
): Record<string, UsageSummary> {
  const rows = queryRows<ApiKeyUsageSummaryRow>(
    `
      SELECT
        api_key_id AS apiKeyId,
        COUNT(*) AS requestCount,
        ${USAGE_SUM_COLUMNS}
      FROM request_log
      WHERE ts >= ? AND ts <= ? AND api_key_id IS NOT NULL
      GROUP BY api_key_id
    `,
    [since, until],
  );
  const result: Record<string, UsageSummary> = {};
  for (const row of rows) {
    result[row.apiKeyId] = withDerivedSummary({
      requestCount: toNumber(row.requestCount),
      ...usageSumsFromRow(row),
      topError: getTopError(since, until, row.apiKeyId),
    });
  }
  return result;
}

function getUsageSummary(since: number, until: number, apiKeyId?: string): UsageSummary {
  const { clause, params } = timeWhere(since, until, apiKeyId);
  const row = queryOne<UsageSummaryRow>(
    `
      SELECT
        COUNT(*) AS requestCount,
        ${USAGE_SUM_COLUMNS}
      FROM request_log
      WHERE ${clause}
    `,
    params,
  );
  return withDerivedSummary({
    requestCount: toNumber(row?.requestCount),
    ...usageSumsFromRow(row),
    topError: getTopError(since, until, apiKeyId),
  });
}

function getTrendBuckets(
  since: number,
  until: number,
  bucketMs: number,
  apiKeyId?: string,
): TrendBucket[] {
  const { clause, params } = timeWhere(since, until, apiKeyId);
  const rows = queryRows<TrendBucketRow>(
    `
      SELECT
        CAST((ts / ?) AS INTEGER) * ? AS startTs,
        COUNT(*) AS requestCount,
        ${USAGE_SUM_COLUMNS}
      FROM request_log
      WHERE ${clause}
      GROUP BY startTs
      ORDER BY startTs ASC
    `,
    [bucketMs, bucketMs, ...params],
  );
  const byStart = new Map(rows.map((row) => [toNumber(row.startTs), row]));
  const buckets: TrendBucket[] = [];
  const firstBucket = Math.floor(since / bucketMs) * bucketMs;

  for (let startTs = firstBucket; startTs <= until; startTs += bucketMs) {
    const row = byStart.get(startTs);
    buckets.push(
      withDerivedSummary({
        startTs,
        requestCount: toNumber(row?.requestCount),
        ...usageSumsFromRow(row),
        topError: null,
      }),
    );
  }

  return buckets;
}

function getTopError(since: number, until: number, apiKeyId?: string): { label: string; count: number } | null {
  const { clause, params } = timeWhere(since, until, apiKeyId);
  const row = queryOne<TopErrorRow>(
    `
      SELECT
        COALESCE(
          NULLIF(error, ''),
          NULLIF(outcome, ''),
          CASE WHEN status IS NULL THEN 'unknown' ELSE 'HTTP ' || status END
        ) AS label,
        COUNT(*) AS count
      FROM request_log
      WHERE ${clause} AND ${ERROR_EXPR}
      GROUP BY label
      ORDER BY count DESC
      LIMIT 1
    `,
    params,
  );
  if (!row) return null;
  return { label: String(row.label).slice(0, 160), count: toNumber(row.count) };
}

function getAccountUsageSummaries(
  since: number,
  until: number,
  accounts: Account[],
  apiKeyId?: string,
): AccountUsageSummary[] {
  const { clause, params } = timeWhere(since, until, apiKeyId);
  const rows = queryRows<AccountUsageSummaryRow>(
    `
      SELECT
        request_log.account_id AS accountId,
        accounts.name AS accountName,
        COUNT(*) AS requestCount,
        ${USAGE_SUM_COLUMNS}
      FROM request_log
      LEFT JOIN accounts ON accounts.id = request_log.account_id
      WHERE ${clause}
      GROUP BY request_log.account_id
      ORDER BY requestCount DESC
    `,
    params,
  );
  const byAccountId = new Map(rows.map((row) => [row.accountId, row]));
  const summaries = accounts.map((account) => {
    const row = byAccountId.get(account.id);
    byAccountId.delete(account.id);
    return accountUsageFromRow(row, account.id, account.name, toCreditApproximation(account, until));
  });

  for (const row of byAccountId.values()) {
    summaries.push(accountUsageFromRow(row, row.accountId, row.accountName, null));
  }

  return summaries;
}

function accountUsageFromRow(
  row: AccountUsageSummaryRow | undefined,
  accountId: string | null,
  accountName: string | null,
  credit: AccountCreditApproximation | null,
): AccountUsageSummary {
  return {
    ...withDerivedSummary({
      requestCount: toNumber(row?.requestCount),
      ...usageSumsFromRow(row),
      topError: null,
    }),
    accountId,
    accountName,
    credit,
  };
}

function toCreditApproximation(account: Account, now: number): AccountCreditApproximation {
  return {
    accountId: account.id,
    accountName: account.name,
    rateLimitStatus: account.rate_limit_status,
    rateLimitRemaining: account.rate_limit_remaining,
    rateLimitReset: account.rate_limit_reset,
    fiveHourRemaining: windowCreditsRemaining(
      account.rate_limit_5h_utilization,
      account.rate_limit_5h_reset,
      usageWindowUtilization(account, "session", now),
      FIVE_HOUR_CREDITS_PER_ACCOUNT,
      now,
    ),
    sevenDayRemaining: windowCreditsRemaining(
      account.rate_limit_7d_utilization,
      account.rate_limit_7d_reset,
      usageWindowUtilization(account, "week_all_models", now),
      SEVEN_DAY_CREDITS_PER_ACCOUNT,
      now,
    ),
  };
}

/**
 * Convert a window's used fraction into remaining credits. Header data wins
 * (updated on every proxied response); a reset in the past means the window
 * rolled over while the account was idle, so fall back to the /usage probe
 * snapshot, which itself may be null.
 */
function windowCreditsRemaining(
  headerUtilization: number | null,
  headerReset: number | null,
  probeUtilization: number | null,
  credits: number,
  now: number,
): number | null {
  const headerFresh = headerUtilization !== null && (headerReset === null || headerReset > now);
  const utilization = headerFresh ? headerUtilization : probeUtilization;
  if (utilization === null) return null;
  return Math.round(Math.min(1, Math.max(0, 1 - utilization)) * credits);
}

/** Used fraction (0..1) from the stored /usage probe snapshot, if still current. */
function usageWindowUtilization(account: Account, kind: string, now: number): number | null {
  if (account.usage_windows === null) return null;
  try {
    const parsed: unknown = JSON.parse(account.usage_windows);
    if (!Array.isArray(parsed)) return null;
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const window: Partial<Record<"kind" | "usedPercent" | "resetsAtMs", unknown>> = entry;
      if (window.kind !== kind || typeof window.usedPercent !== "number") continue;
      if (typeof window.resetsAtMs === "number" && window.resetsAtMs <= now) return null;
      return window.usedPercent / 100;
    }
    return null;
  } catch {
    return null;
  }
}

function rangeWindow(range: AnalyticsRange, now: number): { since: number; until: number; bucketMs: number } {
  const ms =
    range === "1d" ? 24 * 60 * 60 * 1000 : range === "7d" ? SEVEN_DAYS_MS : THIRTY_DAYS_MS;
  const bucketMs =
    range === "1d" ? 60 * 60 * 1000 : range === "7d" ? 6 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return { since: now - ms, until: now, bucketMs };
}

function timeWhere(
  since: number,
  until: number,
  apiKeyId?: string,
): { clause: string; params: Array<string | number> } {
  if (apiKeyId) {
    return { clause: "ts >= ? AND ts <= ? AND api_key_id = ?", params: [since, until, apiKeyId] };
  }
  return { clause: "ts >= ? AND ts <= ?", params: [since, until] };
}

function usageSumsFromRow(
  row: UsageSummaryRow | null | undefined,
): Omit<UsageSummary, "requestCount" | "errorRate" | "cacheHitRate" | "topError"> {
  return {
    tokenTotal: toNumber(row?.tokenTotal),
    cachedTokenTotal: toNumber(row?.cachedTokenTotal),
    inputTokenTotal: toNumber(row?.inputTokenTotal),
    cacheReadTokens: toNumber(row?.cacheReadTokens),
    cacheCreationTokens: toNumber(row?.cacheCreationTokens),
    costUsd: toNumber(row?.costUsd),
    errorCount: toNumber(row?.errorCount),
  };
}

function withDerivedSummary<T extends Omit<UsageSummary, "errorRate" | "cacheHitRate">>(
  summary: T,
): T & UsageSummary {
  const cacheDenominator =
    summary.inputTokenTotal + summary.cacheReadTokens + summary.cacheCreationTokens;
  return {
    ...summary,
    errorRate: summary.requestCount > 0 ? summary.errorCount / summary.requestCount : 0,
    cacheHitRate: cacheDenominator > 0 ? summary.cacheReadTokens / cacheDenominator : 0,
  };
}

function sumNullable(values: Array<number | null>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

function queryOne<T>(sql: string, params: Array<string | number>): T | null {
  const row = db.query<T, Array<string | number>>(sql).get(...params);
  return row ?? null;
}

function queryRows<T>(sql: string, params: Array<string | number>): T[] {
  return db.query<T, Array<string | number>>(sql).all(...params);
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

interface UsageSummaryRow {
  requestCount: number;
  tokenTotal: number;
  cachedTokenTotal: number;
  inputTokenTotal: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  errorCount: number;
}

interface TrendBucketRow extends UsageSummaryRow {
  startTs: number;
}

interface TopErrorRow {
  label: string;
  count: number;
}

interface AccountUsageSummaryRow extends UsageSummaryRow {
  accountId: string | null;
  accountName: string | null;
}

interface ApiKeyUsageSummaryRow extends UsageSummaryRow {
  apiKeyId: string;
}
