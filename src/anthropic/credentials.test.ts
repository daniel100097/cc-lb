import { describe, expect, test } from "bun:test";
import { parseClaudeCodeOAuthToken, parseCredentials } from "./credentials";

describe("parseCredentials", () => {
  test("accepts the Claude credentials file shape", () => {
    const account = parseCredentials(
      {
        claudeAiOauth: {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: 1_800_000_000_000,
          scopes: ["user:inference", "user:profile"],
        },
      },
      "Main",
    );

    expect(account.name).toBe("Main");
    expect(account.access_token).toBe("access");
    expect(account.refresh_token).toBe("refresh");
    expect(account.expires_at).toBe(1_800_000_000_000);
    expect(account.scopes).toBe("user:inference user:profile");
  });

  test("accepts the inner oauth object", () => {
    const account = parseCredentials({ accessToken: "a", refreshToken: "r" });
    expect(account.name).toBe("Imported account");
    expect(account.expires_at).toBeNull();
  });

  test("rejects missing token fields", () => {
    expect(() => parseCredentials({ accessToken: "a" })).toThrow();
  });

  test("parses Claude Code OAuth token accounts", () => {
    const now = 1_800_000_000_000;
    const account = parseClaudeCodeOAuthToken("  claude-code-oauth-token-value  ", "Token", now);
    expect(account.name).toBe("Token");
    expect(account.auth_type).toBe("claude_code_oauth_token");
    expect(account.access_token).toBe("claude-code-oauth-token-value");
    expect(account.refresh_token).toBeNull();
    expect(account.expires_at).toBeGreaterThan(now);
  });

  test("accepts Claude Code token env var output", () => {
    const account = parseClaudeCodeOAuthToken("export CLAUDE_CODE_OAUTH_TOKEN='claude-code-oauth-token-value-for-env'");
    expect(account.access_token).toBe("claude-code-oauth-token-value-for-env");
  });
});
