import { z } from "zod";
import { beginClaudeCodeLogin, completeClaudeCodeLogin, getClaudeCodeLoginStatus } from "../anthropic/claude-code-cli";
import {
  accountHasCredentials,
  adoptLoginConfigDir,
  deleteAccountConfigDir,
  readCredentialsFile,
} from "../anthropic/account-config";
import { probeAccount, probeTmuxSessionName } from "../anthropic/account-probe";
import { killTmuxSession } from "../anthropic/tmux-driver";
import type { UsageWindow } from "../anthropic/usage-panel";
import { STRATEGIES } from "../balancer/strategies";
import { isAvailable, toState } from "../balancer/types";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccount,
  type Account,
  type AccountPatch,
} from "../db/accounts";
import {
  createApiKey,
  deleteApiKey,
  getApiKey,
  listApiKeys,
  regenerateApiKey,
  updateApiKey,
  type ApiKey,
} from "../db/api-keys";
import {
  getApiKeyAnalytics,
  getDashboardAnalytics,
  listApiKeyUsageSummaries,
  type AnalyticsRange,
  type UsageSummary,
} from "../db/analytics";
import {
  countOutcomesSince,
  countRequestsSince,
  listRecentRequests,
  listRequestModels,
  listRequestOutcomes,
  listRequests,
  type RequestLogEntry,
} from "../db/request-log";
import { getSettings, patchSettings } from "../db/settings";
import {
  deleteFilteredStickySessions,
  deleteStickySessions,
  listStickySessions,
  purgeStaleStickySessions,
  type StickySessionEntry,
} from "../db/sticky";
import { publicProcedure, router } from "./trpc";

const strategySchema = z.enum([
  "priority",
  "round_robin",
  "least_used",
  "weighted_random",
  "session_reset_drain",
]);

const settingsPatchSchema = z
  .object({
    strategy: strategySchema.optional(),
    stickySessions: z.boolean().optional(),
    stickyTtlMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
    apiKeyAuthEnabled: z.boolean().optional(),
    rateLimitBackoffBaseMs: z.number().int().min(1_000).max(60 * 60 * 1000).optional(),
    rateLimitBackoffMaxMs: z.number().int().min(1_000).max(24 * 60 * 60 * 1000).optional(),
    sessionDurationMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
    overloadRetryMax: z.number().int().min(0).max(10).optional(),
  })
  .strict();

const accountPatchSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    deviceIdOverride: z.string().trim().max(200).nullable().optional(),
    paused: z.boolean().optional(),
    pauseReason: z.string().trim().max(300).nullable().optional(),
    needsReauth: z.boolean().optional(),
  })
  .strict();

const claudeCodeLoginCompleteSchema = z
  .object({
    sessionId: z.string().min(1),
    code: z.string().trim().min(1).max(4_000),
    name: z.string().trim().max(120).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    deviceIdOverride: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const claudeCodeLoginStatusSchema = z.object({ sessionId: z.string().min(1) }).strict();

const requestFilterSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    accountId: z.string().min(1).nullable().optional(),
    apiKeyId: z.string().min(1).nullable().optional(),
    outcome: z.string().min(1).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    since: z.number().int().nullable().optional(),
    until: z.number().int().nullable().optional(),
    search: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const apiKeyStatusSchema = z.enum(["active", "inactive"]);

const apiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    status: apiKeyStatusSchema.optional(),
    isActive: z.boolean().optional(),
    expiresAt: z.number().int().nullable().optional(),
    allowedModels: z.array(z.string().trim().min(1).max(120)).max(100).nullable().optional(),
    trafficClass: z.string().trim().min(1).max(80).optional(),
    accountScopeEnabled: z.boolean().optional(),
    assignedAccountIds: z.array(z.string().min(1)).max(500).optional(),
  })
  .strict();

const apiKeyUpdateSchema = apiKeyCreateSchema
  .partial()
  .extend({ id: z.string().min(1) })
  .strict();

const apiKeyIdSchema = z.object({ id: z.string().min(1) }).strict();

const analyticsRangeSchema = z.enum(["1d", "7d", "30d"]);
type AnalyticsRangeInput = z.infer<typeof analyticsRangeSchema>;
const analyticsRangeInputSchema = z.object({ range: analyticsRangeSchema.optional() }).strict();
const apiKeyAnalyticsInputSchema = z
  .object({ id: z.string().min(1), range: analyticsRangeSchema.optional() })
  .strict();

const stickyListSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
    accountId: z.string().min(1).nullable().optional(),
    accountQuery: z.string().trim().max(200).nullable().optional(),
    search: z.string().trim().max(200).nullable().optional(),
    stale: z.boolean().nullable().optional(),
    sortBy: z.enum(["updated_at", "key", "account_name"]).optional(),
    sortDirection: z.enum(["asc", "desc"]).optional(),
  })
  .strict();

const stickyDeleteSelectedSchema = z.object({ keys: z.array(z.string().min(1)).max(1_000) }).strict();

const FIXED_OUTCOMES = [
  "ok",
  "rate_limited",
  "unauthorized",
  "network_error",
  "token_error",
  "upstream_error",
  "telemetry",
];

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, service: "cc-lb", time: Date.now() })),

  strategies: publicProcedure.query(() =>
    Object.values(STRATEGIES).map((strategy) => ({
      name: strategy.name,
      description: strategy.description,
    })),
  ),

  accounts: router({
    list: publicProcedure.query(() => listAccounts().map((account) => toPublicAccount(account))),

    claudeCodeLoginBegin: publicProcedure.mutation(() => beginClaudeCodeLogin()),

    claudeCodeLoginStatus: publicProcedure.input(claudeCodeLoginStatusSchema).query(({ input }) =>
      getClaudeCodeLoginStatus(input.sessionId),
    ),

    // Account creation goes through the Claude Code CLI only. The login session's
    // config dir (with the CLI-written .credentials.json) is adopted into the
    // account's persistent dir; Claude Code owns tokens from there on.
    claudeCodeLoginComplete: publicProcedure.input(claudeCodeLoginCompleteSchema).mutation(async ({ input }) => {
      const login = await completeClaudeCodeLogin(input.sessionId, input.code);
      const account = createAccount({
        name: input.name?.trim() || "Claude Code account",
        priority: input.priority ?? 0,
        device_id_override: normalizeOptionalString(input.deviceIdOverride),
      });
      adoptLoginConfigDir(account.id, login.configDir);
      void probeAccount(account.id, "seed").catch(() => {});
      return toPublicAccount(account);
    }),

    // Boot the CLI + /usage to refresh the token and capture utilization on demand.
    usageProbe: publicProcedure.input(z.object({ id: z.string().min(1) }).strict()).mutation(async ({ input }) => {
      if (!getAccount(input.id)) throw new Error("account not found");
      const result = await probeAccount(input.id, "manual");
      const account = getAccount(input.id);
      if (!account) throw new Error("account not found");
      return {
        outcome: result.outcome,
        usage: result.usage?.windows ?? null,
        account: toPublicAccount(account),
      };
    }),

    update: publicProcedure.input(accountPatchSchema).mutation(({ input }) => {
      const patch: AccountPatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.deviceIdOverride !== undefined) patch.device_id_override = normalizeOptionalString(input.deviceIdOverride);
      if (input.paused !== undefined) {
        patch.paused = input.paused ? 1 : 0;
        patch.pause_reason = input.paused ? input.pauseReason ?? "Paused from dashboard" : null;
      } else if (input.pauseReason !== undefined) {
        patch.pause_reason = input.pauseReason;
      }
      if (input.needsReauth !== undefined) patch.needs_reauth = input.needsReauth ? 1 : 0;

      updateAccount(input.id, patch);
      const account = getAccount(input.id);
      if (!account) throw new Error("account not found");
      return toPublicAccount(account);
    }),

    delete: publicProcedure.input(z.object({ id: z.string().min(1) }).strict()).mutation(({ input }) => {
      void killTmuxSession(probeTmuxSessionName(input.id)).catch(() => {});
      deleteAccountConfigDir(input.id);
      deleteAccount(input.id);
      return { ok: true };
    }),
  }),

  settings: router({
    get: publicProcedure.query(() => getSettings()),
    update: publicProcedure.input(settingsPatchSchema).mutation(({ input }) => patchSettings(input)),
  }),

  apiKeys: router({
    list: publicProcedure.query(() => {
      const usageByKey = listApiKeyUsageSummaries();
      return listApiKeys().map((apiKey) => toPublicApiKey(apiKey, usageByKey[apiKey.id]));
    }),

    get: publicProcedure.input(apiKeyIdSchema).query(({ input }) => {
      const apiKey = getApiKey(input.id);
      if (!apiKey) throw new Error("api key not found");
      return toPublicApiKey(apiKey, listApiKeyUsageSummaries()[apiKey.id]);
    }),

    create: publicProcedure.input(apiKeyCreateSchema).mutation(({ input }) => {
      const created = createApiKey({
        name: input.name,
        status: input.status ?? (input.isActive === false ? "inactive" : undefined),
        expires_at: input.expiresAt ?? null,
        allowed_models: input.allowedModels ?? null,
        traffic_class: input.trafficClass,
        account_scope_enabled: input.accountScopeEnabled ? 1 : 0,
        assigned_account_ids: input.assignedAccountIds ?? [],
      });
      return {
        apiKey: toPublicApiKey(created.apiKey),
        plaintextKey: created.plaintextKey,
      };
    }),

    update: publicProcedure.input(apiKeyUpdateSchema).mutation(({ input }) => {
      const updated = updateApiKey(input.id, {
        name: input.name,
        status: input.status ?? (input.isActive === undefined ? undefined : input.isActive ? "active" : "inactive"),
        expires_at: input.expiresAt,
        allowed_models: input.allowedModels,
        traffic_class: input.trafficClass,
        account_scope_enabled:
          input.accountScopeEnabled === undefined ? undefined : input.accountScopeEnabled ? 1 : 0,
        assigned_account_ids: input.assignedAccountIds,
      });
      if (!updated) throw new Error("api key not found");
      return toPublicApiKey(updated, listApiKeyUsageSummaries()[updated.id]);
    }),

    delete: publicProcedure.input(apiKeyIdSchema).mutation(({ input }) => {
      deleteApiKey(input.id);
      return { ok: true };
    }),

    regenerate: publicProcedure.input(apiKeyIdSchema).mutation(({ input }) => {
      const regenerated = regenerateApiKey(input.id);
      if (!regenerated) throw new Error("api key not found");
      return {
        apiKey: toPublicApiKey(regenerated.apiKey),
        plaintextKey: regenerated.plaintextKey,
      };
    }),

    analytics: publicProcedure.input(apiKeyAnalyticsInputSchema).query(({ input }) =>
      getApiKeyAnalytics(input.id, analyticsRangeOrDefault(input.range, "7d")),
    ),
  }),

  requests: router({
    list: publicProcedure.input(requestFilterSchema.optional()).query(({ input }) => {
      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;
      const page = listRequests({
        limit,
        offset,
        accountId: input?.accountId ?? null,
        apiKeyId: input?.apiKeyId ?? null,
        outcome: input?.outcome ?? null,
        model: input?.model ?? null,
        since: input?.since ?? null,
        until: input?.until ?? null,
        search: input?.search?.trim() || null,
      });
      return {
        entries: page.entries.map(toPublicRequestLogEntry),
        total: page.total,
        hasMore: offset + page.entries.length < page.total,
      };
    }),
    options: publicProcedure.query(() => ({
      accounts: listAccounts().map((account) => ({ id: account.id, name: account.name })),
      apiKeys: listApiKeys().map((apiKey) => ({ id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix })),
      models: listRequestModels(),
      outcomes: Array.from(new Set([...FIXED_OUTCOMES, ...listRequestOutcomes()])),
    })),
  }),

  analytics: router({
    dashboard: publicProcedure.input(analyticsRangeInputSchema.optional()).query(({ input }) =>
      getDashboardAnalytics(analyticsRangeOrDefault(input?.range, "1d")),
    ),
    overview: publicProcedure.input(analyticsRangeInputSchema.optional()).query(({ input }) =>
      getDashboardAnalytics(analyticsRangeOrDefault(input?.range, "1d")),
    ),
    dashboardRanges: publicProcedure.query(() => ({
      "1d": getDashboardAnalytics("1d"),
      "7d": getDashboardAnalytics("7d"),
      "30d": getDashboardAnalytics("30d"),
    })),
    apiKey: publicProcedure.input(apiKeyAnalyticsInputSchema).query(({ input }) =>
      getApiKeyAnalytics(input.id, analyticsRangeOrDefault(input.range, "7d")),
    ),
  }),

  stickySessions: router({
    list: publicProcedure.input(stickyListSchema.optional()).query(({ input }) => {
      const settings = getSettings();
      const page = listStickySessions({
        limit: input?.limit ?? 50,
        offset: input?.offset ?? 0,
        ttlMs: settings.stickyTtlMs,
        now: Date.now(),
        accountId: input?.accountId ?? null,
        accountQuery: input?.accountQuery?.trim() || null,
        search: input?.search?.trim() || null,
        stale: input?.stale ?? null,
        sortBy: input?.sortBy ?? "updated_at",
        sortDirection: input?.sortDirection ?? "desc",
      });
      return {
        entries: page.entries.map(toPublicStickySession),
        total: page.total,
        stalePromptCacheCount: page.stalePromptCacheCount,
        hasMore: (input?.offset ?? 0) + page.entries.length < page.total,
      };
    }),

    deleteSelected: publicProcedure.input(stickyDeleteSelectedSchema).mutation(({ input }) => {
      const deleted = deleteStickySessions(input.keys);
      return { deleted, deletedCount: deleted };
    }),

    deleteFiltered: publicProcedure.input(stickyListSchema.optional()).mutation(({ input }) => {
      const settings = getSettings();
      const deleted = deleteFilteredStickySessions({
        limit: 1,
        offset: 0,
        ttlMs: settings.stickyTtlMs,
        now: Date.now(),
        accountId: input?.accountId ?? null,
        accountQuery: input?.accountQuery?.trim() || null,
        search: input?.search?.trim() || null,
        stale: input?.stale ?? null,
        sortBy: input?.sortBy ?? "updated_at",
        sortDirection: input?.sortDirection ?? "desc",
      });
      return { deleted, deletedCount: deleted };
    }),

    purgeStale: publicProcedure.mutation(() => {
      const settings = getSettings();
      const deleted = purgeStaleStickySessions(settings.stickyTtlMs, Date.now());
      return { deleted, deletedCount: deleted };
    }),
  }),

  stats: publicProcedure.query(() => {
    const accounts = listAccounts();
    const now = Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const publicAccounts = accounts.map((account) => toPublicAccount(account, now));

    return {
      totalAccounts: accounts.length,
      availableAccounts: publicAccounts.filter((account) => account.status === "active").length,
      pausedAccounts: publicAccounts.filter((account) => account.status === "paused").length,
      rateLimitedAccounts: publicAccounts.filter((account) => account.status === "rate_limited").length,
      needsReauthAccounts: publicAccounts.filter((account) => account.status === "needs_reauth").length,
      totalRequests: accounts.reduce((sum, account) => sum + account.request_count, 0),
      requestsToday: countRequestsSince(todayStart.getTime()),
      outcomesToday: countOutcomesSince(todayStart.getTime()),
      recentRequests: listRecentRequests(12),
    };
  }),
});

export type AppRouter = typeof appRouter;

function toPublicAccount(account: Account, now = Date.now()) {
  const state = toState(account, now);
  const available = isAvailable(state, now);
  // Tokens live in the Claude-Code-managed credentials file, not the DB.
  const credentials = readCredentialsFile(account.id);
  const hasCredentials = credentials !== null || accountHasCredentials(account.id);
  const status =
    account.paused === 1
      ? "paused"
      : account.needs_reauth === 1 || !hasCredentials
        ? "needs_reauth"
        : account.rate_limited_until !== null && account.rate_limited_until > now
          ? "rate_limited"
          : available
            ? "active"
            : "expired";

  return {
    id: account.id,
    name: account.name,
    authType: account.auth_type,
    deviceIdOverride: account.device_id_override,
    status,
    priority: account.priority,
    requestCount: account.request_count,
    sessionRequestCount: account.session_request_count,
    createdAt: account.created_at,
    lastUsed: account.last_used,
    expiresAt: credentials?.expiresAt ?? null,
    scopes: credentials?.scopes ?? null,
    hasCredentials,
    rateLimitStatus: account.rate_limit_status,
    rateLimitReset: account.rate_limit_reset,
    rateLimitRemaining: account.rate_limit_remaining,
    rateLimitedUntil: account.rate_limited_until,
    consecutiveRateLimits: account.consecutive_rate_limits,
    needsReauth: account.needs_reauth === 1 || !hasCredentials,
    paused: account.paused === 1,
    pauseReason: account.pause_reason,
    usage: parseUsageWindows(account.usage_windows),
    usageCheckedAt: account.usage_checked_at,
    available,
  };
}

function parseUsageWindows(raw: string | null): UsageWindow[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isUsageWindow) : null;
  } catch {
    return null;
  }
}

function isUsageWindow(value: unknown): value is UsageWindow {
  return typeof value === "object" && value !== null && "kind" in value && "usedPercent" in value;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toPublicRequestLogEntry(entry: RequestLogEntry) {
  return {
    id: entry.id,
    accountId: entry.account_id,
    accountName: entry.account_name,
    apiKeyId: entry.api_key_id,
    apiKeyName: entry.api_key_name,
    ts: entry.ts,
    status: entry.status,
    model: entry.model,
    outcome: entry.outcome ?? "unknown",
    method: entry.method,
    path: entry.path,
    failoverAttempt: entry.failover_attempt,
    latencyMs: entry.latency_ms,
    totalMs: entry.total_ms,
    error: entry.error,
    upstreamRequestId: entry.upstream_request_id,
    inputTokens: entry.input_tokens,
    outputTokens: entry.output_tokens,
    cacheReadTokens: entry.cache_read_tokens,
    cacheCreationTokens: entry.cache_creation_tokens,
    costUsd: entry.cost_usd,
  };
}

function toPublicApiKey(apiKey: ApiKey, usage = emptyUsageSummary()) {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    status: apiKey.status,
    computedStatus: apiKey.computed_status,
    expiresAt: apiKey.expires_at,
    allowedModels: apiKey.allowed_models,
    trafficClass: apiKey.traffic_class,
    accountScopeEnabled: apiKey.account_scope_enabled === 1,
    assignedAccountIds: apiKey.assigned_account_ids,
    createdAt: apiKey.created_at,
    updatedAt: apiKey.updated_at,
    lastUsedAt: apiKey.last_used_at,
    usage: {
      requestCount: usage.requestCount,
      tokenTotal: usage.tokenTotal,
      cachedTokenTotal: usage.cachedTokenTotal,
      costUsd: usage.costUsd,
      errorCount: usage.errorCount,
      errorRate: usage.errorRate,
      topError: usage.topError,
    },
  };
}

function emptyUsageSummary(): UsageSummary {
  return {
    requestCount: 0,
    tokenTotal: 0,
    cachedTokenTotal: 0,
    costUsd: 0,
    errorCount: 0,
    errorRate: 0,
    topError: null,
  };
}

function toPublicStickySession(entry: StickySessionEntry) {
  return {
    key: entry.key,
    kind: entry.kind,
    accountId: entry.account_id,
    accountName: entry.account_name,
    updatedAt: entry.updated_at,
    expiresAt: entry.expires_at,
    ageMs: entry.age_ms,
    stale: entry.stale,
  };
}

function analyticsRangeOrDefault(value: AnalyticsRangeInput | undefined, fallback: AnalyticsRange): AnalyticsRange {
  return value ?? fallback;
}
