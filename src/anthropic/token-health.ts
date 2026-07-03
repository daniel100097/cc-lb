import type { Account } from "../db/accounts";

const DAY_MS = 24 * 60 * 60 * 1000;
export const REFRESH_TOKEN_WARNING_THRESHOLD_MS = 7 * DAY_MS;
export const REFRESH_TOKEN_CRITICAL_THRESHOLD_MS = 3 * DAY_MS;
export const REFRESH_TOKEN_MAX_AGE_MS = 90 * DAY_MS;

export type TokenHealthStatus = "healthy" | "warning" | "critical" | "expired" | "no_refresh_token";

export interface TokenHealth {
  status: TokenHealthStatus;
  message: string;
  refreshTokenAgeDays: number | null;
  daysUntilExpiration: number | null;
  requiresReauth: boolean;
}

export function checkRefreshTokenHealth(account: Account, now = Date.now()): TokenHealth {
  if (!account.refresh_token) {
    return {
      status: "no_refresh_token",
      message: "OAuth account is missing a refresh token.",
      refreshTokenAgeDays: null,
      daysUntilExpiration: null,
      requiresReauth: true,
    };
  }

  const issuedAt = account.refresh_token_issued_at;
  if (issuedAt === null) {
    return {
      status: "warning",
      message: "Refresh token issue time is unknown.",
      refreshTokenAgeDays: null,
      daysUntilExpiration: null,
      requiresReauth: false,
    };
  }

  const ageMs = Math.max(0, now - issuedAt);
  const ageDays = Math.floor(ageMs / DAY_MS);
  const remainingMs = issuedAt + REFRESH_TOKEN_MAX_AGE_MS - now;
  const daysUntilExpiration = Math.ceil(remainingMs / DAY_MS);

  if (remainingMs <= 0) {
    return {
      status: "expired",
      message: "Refresh token is likely expired; re-authenticate this account.",
      refreshTokenAgeDays: ageDays,
      daysUntilExpiration,
      requiresReauth: true,
    };
  }

  if (remainingMs <= REFRESH_TOKEN_CRITICAL_THRESHOLD_MS) {
    return {
      status: "critical",
      message: `Refresh token expires in ${daysUntilExpiration} days.`,
      refreshTokenAgeDays: ageDays,
      daysUntilExpiration,
      requiresReauth: true,
    };
  }

  if (remainingMs <= REFRESH_TOKEN_WARNING_THRESHOLD_MS || ageMs > 60 * DAY_MS) {
    return {
      status: "warning",
      message: `Refresh token expires in ${daysUntilExpiration} days.`,
      refreshTokenAgeDays: ageDays,
      daysUntilExpiration,
      requiresReauth: false,
    };
  }

  return {
    status: "healthy",
    message: `Refresh token expires in about ${daysUntilExpiration} days.`,
    refreshTokenAgeDays: ageDays,
    daysUntilExpiration,
    requiresReauth: false,
  };
}
