// Periodic /usage snapshot refresh. Accounts that served a request recently
// get a fresh snapshot every ACTIVE_REFRESH_INTERVAL_MS so routing (the
// new-session usage cutoff) sees recent 5h-window utilization; idle
// accounts refresh only every IDLE_REFRESH_INTERVAL_MS to avoid pointless CLI
// boots. Probe-level dedup/backoff and the tmux semaphore bound the cost.

import { listAccounts, type Account } from "../db/accounts";
import { accountHasCredentials } from "./account-config";
import { probeAccount } from "./account-probe";

export const ACTIVE_REFRESH_INTERVAL_MS = 45 * 60_000;
export const IDLE_REFRESH_INTERVAL_MS = 3 * 60 * 60_000;
/** Total jitter band around the base interval (±15%). */
const USAGE_JITTER_SPREAD = 0.3;
const TICK_MS = 60_000;

/**
 * Stable per-account factor in [0.85, 1.15) so refresh timers don't align
 * across accounts. Deterministic (hash of the account id): no flapping between
 * ticks, and distinct effective periods keep accounts drifting apart.
 */
export function usageJitterFactor(accountId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < accountId.length; i += 1) {
    hash ^= accountId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unit = (hash >>> 0) / 4294967296;
  return 1 + (unit - 0.5) * USAGE_JITTER_SPREAD;
}

/** Active = the account served a request within the active refresh interval. */
export function usageRefreshDue(account: Account, now: number): boolean {
  if (account.paused === 1 || account.needs_reauth === 1) return false;
  const active = account.last_used !== null && now - account.last_used < ACTIVE_REFRESH_INTERVAL_MS;
  const interval = (active ? ACTIVE_REFRESH_INTERVAL_MS : IDLE_REFRESH_INTERVAL_MS) * usageJitterFactor(account.id);
  return now - (account.usage_checked_at ?? 0) >= interval;
}

export function refreshDueUsage(now = Date.now()): void {
  for (const account of listAccounts()) {
    if (!usageRefreshDue(account, now)) continue;
    if (!accountHasCredentials(account.id)) continue;
    void probeAccount(account.id, "usage").catch(() => {
      /* probe backoff / reauth marking handle failures */
    });
  }
}

export function startUsageRefresher(): Timer {
  refreshDueUsage();
  return setInterval(() => refreshDueUsage(), TICK_MS);
}
