import type { NewAccount } from "../db/accounts";
import { z } from "zod";

const claudeAiOauthSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).optional(),
});

const credentialsFileSchema = z.object({
  claudeAiOauth: claudeAiOauthSchema,
});

const CLAUDE_CODE_OAUTH_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parse a pasted credentials JSON blob into a NewAccount.
 * Accepts either the whole file `{ claudeAiOauth: {...} }` or the inner object.
 * Throws on missing tokens.
 */
export function parseCredentials(input: unknown, name?: string): NewAccount {
  const obj = typeof input === "string" ? JSON.parse(input) : input;
  const file = credentialsFileSchema.safeParse(obj);
  const oauth = file.success ? file.data.claudeAiOauth : claudeAiOauthSchema.parse(obj);

  return {
    name: name?.trim() || "Imported account",
    auth_type: "oauth_refresh",
    access_token: oauth.accessToken,
    refresh_token: oauth.refreshToken,
    // expiresAt is already ms epoch in the Claude Code file.
    expires_at: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.join(" ") : null,
  };
}

/** Parse a Claude Code `claude setup-token` OAuth token into an access-token account. */
export function parseClaudeCodeOAuthToken(input: string, name?: string, now = Date.now()): NewAccount {
  const token = extractClaudeCodeOAuthToken(input);
  if (token.length < 20) {
    throw new Error("Claude Code OAuth token is too short.");
  }

  return {
    name: name?.trim() || "Claude Code token account",
    auth_type: "claude_code_oauth_token",
    access_token: token,
    refresh_token: null,
    expires_at: now + CLAUDE_CODE_OAUTH_TOKEN_TTL_MS,
    refresh_token_issued_at: null,
    scopes: "claude_code_oauth_token",
  };
}

export function extractClaudeCodeOAuthToken(input: string): string {
  return findClaudeCodeOAuthToken(input) ?? input.trim();
}

export function findClaudeCodeOAuthToken(input: string): string | null {
  const trimmed = input.trim();
  const envMatch = trimmed.match(/(?:^|\s)(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const token = envMatch?.[1] ?? envMatch?.[2] ?? envMatch?.[3];
  return token ? token.trim() : null;
}
