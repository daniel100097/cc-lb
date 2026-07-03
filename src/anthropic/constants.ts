// Public Claude Code OAuth client + endpoints. Copied from better-ccflare so our
// OAuth interops with real Claude Pro/Max accounts.
export const CLIENT_ID = process.env.CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const AUTH_URL = "https://claude.ai/oauth/authorize";
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const API_BASE = process.env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com";

export const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

// Refresh proactively when within 30 min of expiry.
export const TOKEN_SAFETY_WINDOW_MS = 30 * 60 * 1000;
// After a failed refresh, don't retry over the network for 60s.
export const TOKEN_REFRESH_BACKOFF_MS = 60_000;
