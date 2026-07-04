import type { Account } from "../db/accounts";
import { readCredentialsFile } from "./account-config";
import { isProbeReauthRequiredError, probeAccount } from "./account-probe";
import { TOKEN_SAFETY_WINDOW_MS } from "./constants";

/**
 * Return a valid access token for the account. The token lives in the account's
 * Claude-Code-managed .credentials.json (the source of truth); when it's near or
 * past expiry we refresh it by booting the CLI (see account-probe.ts). This is a
 * thin policy layer — concurrency dedup + backoff live in the probe.
 */
export async function getValidAccessToken(account: Account): Promise<string> {
  const now = Date.now();

  const file = readCredentialsFile(account.id);
  const expiresAt = file?.expiresAt ?? 0;

  // Comfortably valid — serve as-is.
  if (file?.accessToken && expiresAt - now > TOKEN_SAFETY_WINDOW_MS) {
    return file.accessToken;
  }

  // Inside the safety window but not yet expired: serve the current token and
  // refresh in the background so the request adds zero latency.
  if (file?.accessToken && expiresAt > now) {
    void probeAccount(account.id, "safety_window").catch(() => {});
    return file.accessToken;
  }

  // Expired or missing: block on a probe (boots the CLI, which refreshes the
  // file), then re-read the refreshed token.
  try {
    await probeAccount(account.id, "expired");
  } catch (error) {
    if (isProbeReauthRequiredError(error)) account.needs_reauth = 1;
    throw error;
  }

  const refreshed = readCredentialsFile(account.id);
  if (!refreshed?.accessToken) {
    throw new Error(`account ${account.id} has no access token after refresh`);
  }
  return refreshed.accessToken;
}
