import type { Account } from "../db/accounts";
import { updateAccount } from "../db/accounts";
import type { Settings } from "../db/settings";

const HARD_LIMIT_STATUSES = new Set(["rate_limited", "blocked", "queueing_hard", "payment_required"]);
const MAX_RESET_MS = 24 * 60 * 60 * 1000;
const DEFAULT_429_COOLDOWN_MS = 60_000;

export interface RateLimitInfo {
  isRateLimited: boolean;
  status: string | null;
  resetTime: number | null; // ms epoch, or null if unknown
  remaining: number | null;
}

function clampResetTime(ms: number, now: number): number | null {
  if (!Number.isFinite(ms) || ms <= now) return null;
  return Math.min(ms, now + MAX_RESET_MS);
}

/** Parse Anthropic unified rate-limit headers + HTTP status. */
export function parseRateLimit(res: Response, now: number): RateLimitInfo {
  const status = res.headers.get("anthropic-ratelimit-unified-status");
  const resetHeader = res.headers.get("anthropic-ratelimit-unified-reset");
  const remainingHeader = res.headers.get("anthropic-ratelimit-unified-remaining");
  const remaining = remainingHeader !== null ? Number(remainingHeader) : null;

  const hardStatus = status !== null && HARD_LIMIT_STATUSES.has(status);
  const is429 = res.status === 429;
  const is529 = res.status === 529;
  const isRateLimited = hardStatus || is429 || is529;

  let resetTime: number | null = null;
  if (resetHeader) {
    resetTime = clampResetTime(Number(resetHeader) * 1000, now);
  }
  if (resetTime === null && (is429 || is529)) {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const asNum = Number(retryAfter);
      if (Number.isFinite(asNum)) {
        resetTime = clampResetTime(now + asNum * 1000, now);
      } else {
        const asDate = Date.parse(retryAfter);
        if (Number.isFinite(asDate)) resetTime = clampResetTime(asDate, now);
      }
    }
    const xReset = res.headers.get("x-ratelimit-reset");
    if (resetTime === null && xReset) resetTime = clampResetTime(Number(xReset) * 1000, now);
    // 429 with no reset info at all → default cooldown.
    if (resetTime === null && is429) resetTime = now + DEFAULT_429_COOLDOWN_MS;
  }

  return { isRateLimited, status: status ?? null, resetTime, remaining };
}

function computeBackoffMs(consecutive: number, settings: Settings): number {
  const backoff = settings.rateLimitBackoffBaseMs * 2 ** Math.max(0, consecutive - 1);
  return Math.min(backoff, settings.rateLimitBackoffMaxMs);
}

/** Mark the account cooled down: min(reset, now+backoff). */
export function applyCooldown(
  account: Account,
  info: RateLimitInfo,
  settings: Settings,
  now: number,
): void {
  const n = account.consecutive_rate_limits + 1;
  const backoff = computeBackoffMs(n, settings);
  const cooldownUntil = info.resetTime ? Math.min(info.resetTime, now + backoff) : now + backoff;
  updateAccount(account.id, {
    rate_limited_until: cooldownUntil,
    consecutive_rate_limits: n,
    rate_limit_status: info.status,
    rate_limit_reset: info.resetTime,
    rate_limit_remaining: info.remaining,
  });
  account.rate_limited_until = cooldownUntil;
  account.consecutive_rate_limits = n;
}

/** Persist rate-limit metadata on any response carrying a status header. */
export function recordMetadata(account: Account, info: RateLimitInfo): void {
  if (info.status === null && info.resetTime === null && info.remaining === null) return;
  updateAccount(account.id, {
    rate_limit_status: info.status,
    rate_limit_reset: info.resetTime,
    rate_limit_remaining: info.remaining,
  });
}

/** On a successful response, clear cooldown. Reset the counter after a healthy quiet window. */
export function clearRateLimit(account: Account, now = Date.now()): void {
  const healthyForMs = account.last_used === null ? 0 : now - account.last_used;
  const resetConsecutive = account.consecutive_rate_limits > 0 && healthyForMs >= 5 * 60 * 1000;
  if (account.rate_limited_until === null && !resetConsecutive) return;

  updateAccount(account.id, {
    rate_limited_until: null,
    consecutive_rate_limits: resetConsecutive ? 0 : account.consecutive_rate_limits,
  });
  account.rate_limited_until = null;
  if (resetConsecutive) account.consecutive_rate_limits = 0;
}
