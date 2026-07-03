import { z } from "zod";
import { beginOAuth, completeOAuth, consumeOAuthSession } from "../anthropic/oauth";
import { parseCredentials } from "../anthropic/credentials";
import { checkRefreshTokenHealth } from "../anthropic/token-health";
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
import { db } from "../db/client";
import { getOAuthSession } from "../db/oauth-sessions";
import { countOutcomesSince, countRequestsSince, listRecentRequests } from "../db/request-log";
import { getSettings, patchSettings } from "../db/settings";
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
    paused: z.boolean().optional(),
    pauseReason: z.string().trim().max(300).nullable().optional(),
    needsReauth: z.boolean().optional(),
  })
  .strict();

const importCredentialsSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    credentials: z.unknown(),
  })
  .strict();

const beginOAuthSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const completeOAuthSchema = z
  .object({
    sessionId: z.string().min(1),
    code: z.string().min(1),
    name: z.string().trim().max(120).optional(),
  })
  .strict();

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

    import: publicProcedure.input(importCredentialsSchema).mutation(({ input }) => {
      const parsed = parseCredentials(input.credentials, input.name);
      const account = createAccount({ ...parsed, priority: input.priority ?? parsed.priority });
      return toPublicAccount(account);
    }),

    oauthBegin: publicProcedure.input(beginOAuthSchema.optional()).mutation(({ input }) =>
      beginOAuth({
        name: input?.name ?? null,
        priority: input?.priority ?? 0,
      }),
    ),

    oauthComplete: publicProcedure.input(completeOAuthSchema).mutation(async ({ input }) => {
      const pendingSession = getOAuthSession(input.sessionId);
      if (!pendingSession) throw new Error("oauth session expired or not found");
      if (pendingSession.account_id) throw new Error("oauth session is for account reauth");
      const completion = await completeOAuth(input.sessionId, input.code);
      const { tokens, session } = completion;
      const account = db.transaction(() => {
        const created = createAccount({
          name: input.name || session.name || "Claude OAuth account",
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_at: tokens.expiresAt,
          refresh_token_issued_at: Date.now(),
          scopes: tokens.scopes,
          priority: session.priority,
        });
        consumeOAuthSession(input.sessionId);
        return created;
      })();
      return toPublicAccount(account);
    }),

    oauthReauthBegin: publicProcedure.input(z.object({ id: z.string().min(1) }).strict()).mutation(({ input }) => {
      const account = getAccount(input.id);
      if (!account) throw new Error("account not found");
      return beginOAuth({
        accountId: account.id,
        name: account.name,
        priority: account.priority,
      });
    }),

    oauthReauthComplete: publicProcedure
      .input(z.object({ sessionId: z.string().min(1), code: z.string().min(1) }).strict())
      .mutation(async ({ input }) => {
        const pendingSession = getOAuthSession(input.sessionId);
        if (!pendingSession) throw new Error("oauth session expired or not found");
        const accountId = pendingSession.account_id;
        if (!accountId) throw new Error("oauth session is not a reauth session");
        if (!getAccount(accountId)) throw new Error("account not found");
        const completion = await completeOAuth(input.sessionId, input.code);
        const { tokens, session } = completion;
        if (session.account_id !== accountId) throw new Error("oauth session target mismatch");
        const account = db.transaction(() => {
          updateAccount(accountId, {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            expires_at: tokens.expiresAt,
            refresh_token_issued_at: Date.now(),
            scopes: tokens.scopes,
            needs_reauth: 0,
            rate_limited_until: null,
            consecutive_rate_limits: 0,
          });
          const updated = getAccount(accountId);
          if (!updated) throw new Error("account not found");
          consumeOAuthSession(input.sessionId);
          return updated;
        })();
        return toPublicAccount(account);
      }),

    update: publicProcedure.input(accountPatchSchema).mutation(({ input }) => {
      const patch: AccountPatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.priority !== undefined) patch.priority = input.priority;
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
      deleteAccount(input.id);
      return { ok: true };
    }),
  }),

  settings: router({
    get: publicProcedure.query(() => getSettings()),
    update: publicProcedure.input(settingsPatchSchema).mutation(({ input }) => patchSettings(input)),
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
  const tokenHealth = checkRefreshTokenHealth(account, now);
  const state = toState(account, now);
  const available = isAvailable(state, now);
  const status =
    account.paused === 1
      ? "paused"
      : account.needs_reauth === 1 || tokenHealth.status === "expired" || tokenHealth.status === "no_refresh_token"
        ? "needs_reauth"
        : account.rate_limited_until !== null && account.rate_limited_until > now
          ? "rate_limited"
          : available
            ? "active"
            : "expired";

  return {
    id: account.id,
    name: account.name,
    status,
    priority: account.priority,
    requestCount: account.request_count,
    sessionRequestCount: account.session_request_count,
    createdAt: account.created_at,
    lastUsed: account.last_used,
    expiresAt: account.expires_at,
    scopes: account.scopes,
    rateLimitStatus: account.rate_limit_status,
    rateLimitReset: account.rate_limit_reset,
    rateLimitRemaining: account.rate_limit_remaining,
    rateLimitedUntil: account.rate_limited_until,
    consecutiveRateLimits: account.consecutive_rate_limits,
    needsReauth: account.needs_reauth === 1 || tokenHealth.requiresReauth,
    paused: account.paused === 1,
    pauseReason: account.pause_reason,
    tokenHealth,
    available,
  };
}
