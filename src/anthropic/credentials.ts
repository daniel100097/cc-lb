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
    access_token: oauth.accessToken,
    refresh_token: oauth.refreshToken,
    // expiresAt is already ms epoch in the Claude Code file.
    expires_at: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.join(" ") : null,
  };
}
