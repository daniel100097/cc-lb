import type { Account } from "../db/accounts";
import { updateAccount } from "../db/accounts";
import type { Settings } from "../db/settings";

const HARD_LIMIT_STATUSES = new Set(["rate_limited", "blocked", "queueing_hard", "payment_required"]);
const MAX_RESET_MS = 24 * 60 * 60 * 1000;
/** A 7d window reset can legitimately sit almost a week out. */
const MAX_WINDOW_RESET_MS = 8 * 24 * 60 * 60 * 1000;
/** Minimum bench once upstream reports a reset; also the default cooldown for a headerless 429. */
export const MIN_COOLDOWN_FLOOR_MS = 60_000;

export interface RateLimitWindow {
  utilization: number | null; // fraction 0..1
  reset: number | null; // ms epoch, or null if unknown
}

export interface RateLimitInfo {
  isRateLimited: boolean;
  status: string | null;
  resetTime: number | null; // ms epoch, or null if unknown
  remaining: number | null;
  fiveHour: RateLimitWindow;
  sevenDay: RateLimitWindow;
  /** 429 scoped to a model/beta (overage-disabled-reason: out_of_credits) — fail over without benching. */
  outOfCredits: boolean;
}

function clampResetTime(ms: number, now: number, maxMs = MAX_RESET_MS): number | null {
  if (!Number.isFinite(ms) || ms <= now) return null;
  return Math.min(ms, now + maxMs);
}

/**
 * Per-window headers (anthropic-ratelimit-unified-5h-*, -7d-*) report a used
 * fraction instead of a remaining count; the flat -remaining header is gone
 * from current OAuth responses.
 */
function parseWindow(res: Response, prefix: "5h" | "7d", now: number): RateLimitWindow {
  const utilizationHeader = res.headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
  const resetHeader = res.headers.get(`anthropic-ratelimit-unified-${prefix}-reset`);
  const utilizationRaw = utilizationHeader !== null ? Number(utilizationHeader) : NaN;
  const utilization = Number.isFinite(utilizationRaw)
    ? Math.min(1, Math.max(0, utilizationRaw))
    : null;
  const reset =
    resetHeader !== null ? clampResetTime(Number(resetHeader) * 1000, now, MAX_WINDOW_RESET_MS) : null;
  return { utilization, reset };
}

/** Parse Anthropic unified rate-limit headers + HTTP status. */
export function parseRateLimit(res: Response, now: number): RateLimitInfo {
  const status = res.headers.get("anthropic-ratelimit-unified-status");
  const resetHeader = res.headers.get("anthropic-ratelimit-unified-reset");
  const remainingHeader = res.headers.get("anthropic-ratelimit-unified-remaining");
  const remaining = remainingHeader !== null ? Number(remainingHeader) : null;
  const fiveHour = parseWindow(res, "5h", now);
  const sevenDay = parseWindow(res, "7d", now);

  const hardStatus = status !== null && HARD_LIMIT_STATUSES.has(status);
  const is429 = res.status === 429;
  const is529 = res.status === 529;
  const isRateLimited = hardStatus || is429 || is529;
  const outOfCredits =
    is429 && res.headers.get("anthropic-ratelimit-unified-overage-disabled-reason") === "out_of_credits";

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
    if (resetTime === null && is429) resetTime = now + MIN_COOLDOWN_FLOOR_MS;
  }

  return { isRateLimited, status: status ?? null, resetTime, remaining, fiveHour, sevenDay, outOfCredits };
}

/** Only overwrite a window's slot when this response actually reported it. */
function windowPatch(info: RateLimitInfo) {
  const patch: {
    rate_limit_5h_utilization?: number | null;
    rate_limit_5h_reset?: number | null;
    rate_limit_7d_utilization?: number | null;
    rate_limit_7d_reset?: number | null;
  } = {};
  if (info.fiveHour.utilization !== null) {
    patch.rate_limit_5h_utilization = info.fiveHour.utilization;
    patch.rate_limit_5h_reset = info.fiveHour.reset;
  }
  if (info.sevenDay.utilization !== null) {
    patch.rate_limit_7d_utilization = info.sevenDay.utilization;
    patch.rate_limit_7d_reset = info.sevenDay.reset;
  }
  return patch;
}

function computeBackoffMs(consecutive: number, settings: Settings): number {
  const backoff = settings.rateLimitBackoffBaseMs * 2 ** Math.max(0, consecutive - 1);
  return Math.min(backoff, settings.rateLimitBackoffMaxMs);
}

/**
 * Mark the account cooled down. When upstream reports a reset, bench until it —
 * never shorter — with a MIN_COOLDOWN_FLOOR_MS floor. Without a reset, pure
 * exponential backoff driven by the consecutive counter.
 */
export function applyCooldown(
  account: Account,
  info: RateLimitInfo,
  settings: Settings,
  now: number,
): void {
  const n = account.consecutive_rate_limits + 1;
  const backoff = computeBackoffMs(n, settings);
  const cooldownUntil =
    info.resetTime !== null ? Math.max(info.resetTime, now + MIN_COOLDOWN_FLOOR_MS) : now + backoff;
  updateAccount(account.id, {
    rate_limited_until: cooldownUntil,
    consecutive_rate_limits: n,
    rate_limit_status: info.status,
    rate_limit_reset: info.resetTime,
    rate_limit_remaining: info.remaining,
    ...windowPatch(info),
  });
  account.rate_limited_until = cooldownUntil;
  account.consecutive_rate_limits = n;
}

/** Persist rate-limit metadata on any response carrying a status header. */
export function recordMetadata(account: Account, info: RateLimitInfo): void {
  const hasWindowData = info.fiveHour.utilization !== null || info.sevenDay.utilization !== null;
  if (info.status === null && info.resetTime === null && info.remaining === null && !hasWindowData) return;
  updateAccount(account.id, {
    rate_limit_status: info.status,
    rate_limit_reset: info.resetTime,
    rate_limit_remaining: info.remaining,
    ...windowPatch(info),
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
