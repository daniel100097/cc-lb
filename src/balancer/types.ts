import type { Account } from "../db/accounts";
import { checkRefreshTokenHealth } from "../anthropic/token-health";

export interface AccountState {
  id: string;
  priority: number;
  paused: boolean;
  needsReauth: boolean;
  rateLimitedUntil: number | null;
  rateLimitReset: number | null;
  rateLimitRemaining: number | null;
  requestCount: number;
  sessionRequestCount: number;
  sessionStart: number | null;
  lastUsed: number | null;
  consecutiveRateLimits: number;
}

export function toState(a: Account, now = Date.now()): AccountState {
  const tokenHealth = checkRefreshTokenHealth(a, now);
  return {
    id: a.id,
    priority: a.priority,
    paused: a.paused === 1,
    needsReauth: a.needs_reauth === 1 || tokenHealth.requiresReauth,
    rateLimitedUntil: a.rate_limited_until,
    rateLimitReset: a.rate_limit_reset,
    rateLimitRemaining: a.rate_limit_remaining,
    requestCount: a.request_count,
    sessionRequestCount: a.session_request_count,
    sessionStart: a.session_start,
    lastUsed: a.last_used,
    consecutiveRateLimits: a.consecutive_rate_limits,
  };
}

export function isAvailable(a: AccountState, now: number): boolean {
  if (a.paused || a.needsReauth) return false;
  if (a.rateLimitedUntil && a.rateLimitedUntil > now) return false;
  return true;
}

export type StrategyName =
  | "priority"
  | "round_robin"
  | "least_used"
  | "weighted_random"
  | "session_reset_drain";

export interface Strategy {
  name: StrategyName;
  description: string;
  pick(available: AccountState[], now: number): AccountState | null;
}
