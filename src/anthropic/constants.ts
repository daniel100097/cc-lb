export const API_BASE = process.env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com";

export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

// Refresh proactively when within 30 min of expiry.
export const TOKEN_SAFETY_WINDOW_MS = 30 * 60 * 1000;
// After a failed CLI refresh probe, don't spawn another for 60s.
export const TOKEN_REFRESH_BACKOFF_MS = 60_000;
