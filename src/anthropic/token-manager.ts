import type { Account } from "../db/accounts";
import { getAccount, updateAccount } from "../db/accounts";
import { TOKEN_REFRESH_BACKOFF_MS, TOKEN_SAFETY_WINDOW_MS } from "./constants";
import { isReauthRequiredError, refreshToken } from "./oauth";

// Per-account in-flight refresh promises — dedup concurrent refreshes.
const inFlight = new Map<string, Promise<string>>();
// Per-account last-failure timestamps for backoff.
const lastFailure = new Map<string, number>();

/** Return a valid access token for the account, refreshing if near/past expiry. */
export async function getValidAccessToken(account: Account): Promise<string> {
  const now = Date.now();
  if (account.auth_type === "claude_code_oauth_token") {
    if (!account.access_token) throw new Error(`account ${account.id} has no Claude Code OAuth token`);
    if (account.expires_at !== null && account.expires_at <= now) {
      updateAccount(account.id, { needs_reauth: 1 });
      account.needs_reauth = 1;
      throw new Error(`Claude Code OAuth token expired for account ${account.id}`);
    }
    return account.access_token;
  }

  if (
    account.access_token &&
    account.expires_at &&
    account.expires_at - now > TOKEN_SAFETY_WINDOW_MS
  ) {
    return account.access_token;
  }
  return refreshAccessTokenSafe(account);
}

async function refreshAccessTokenSafe(account: Account): Promise<string> {
  const existing = inFlight.get(account.id);
  if (existing) return existing;

  const now = Date.now();
  const failedAt = lastFailure.get(account.id);
  if (failedAt && now - failedAt < TOKEN_REFRESH_BACKOFF_MS) {
    // Another process may have refreshed — reload from DB before giving up.
    const fresh = getAccount(account.id);
    if (fresh?.access_token && fresh.expires_at && fresh.expires_at - now > TOKEN_SAFETY_WINDOW_MS) {
      return fresh.access_token;
    }
    throw new Error(`refresh backing off for account ${account.id}`);
  }

  const currentRefreshToken = account.refresh_token;
  if (!currentRefreshToken) throw new Error(`account ${account.id} has no refresh token`);

  const p = (async () => {
    try {
      const result = await refreshToken(currentRefreshToken);
      const refreshTokenIssuedAt = result.refreshToken !== currentRefreshToken ? Date.now() : account.refresh_token_issued_at;
      updateAccount(account.id, {
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_at: result.expiresAt,
        refresh_token_issued_at: refreshTokenIssuedAt,
        needs_reauth: 0,
        last_used: Date.now(),
      });
      // Mutate the in-memory object so concurrent callers see fresh state.
      account.access_token = result.accessToken;
      account.refresh_token = result.refreshToken;
      account.expires_at = result.expiresAt;
      account.refresh_token_issued_at = refreshTokenIssuedAt;
      account.needs_reauth = 0;
      lastFailure.delete(account.id);
      return result.accessToken;
    } catch (err) {
      lastFailure.set(account.id, Date.now());
      if (isReauthRequiredError(err)) {
        updateAccount(account.id, { needs_reauth: 1 });
        account.needs_reauth = 1;
      }
      throw err;
    } finally {
      inFlight.delete(account.id);
    }
  })();

  inFlight.set(account.id, p);
  return p;
}
