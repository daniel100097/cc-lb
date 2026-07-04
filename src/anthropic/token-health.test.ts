import { describe, expect, test } from "bun:test";
import type { Account } from "../db/accounts";
import { checkRefreshTokenHealth } from "./token-health";

const now = 1_800_000_000_000;

function account(patch: Partial<Account>): Account {
  return {
    id: "a",
    name: "Account",
    auth_type: "oauth_refresh",
    device_id_override: null,
    access_token: "access",
    refresh_token: "refresh",
    expires_at: now + 60_000,
    refresh_token_issued_at: now,
    scopes: null,
    created_at: now,
    last_used: null,
    priority: 0,
    request_count: 0,
    session_start: null,
    session_request_count: 0,
    rate_limit_status: null,
    rate_limit_reset: null,
    rate_limit_remaining: null,
    rate_limited_until: null,
    consecutive_rate_limits: 0,
    needs_reauth: 0,
    paused: 0,
    pause_reason: null,
    ...patch,
  };
}

describe("checkRefreshTokenHealth", () => {
  test("marks fresh refresh tokens healthy", () => {
    expect(checkRefreshTokenHealth(account({}), now).status).toBe("healthy");
  });

  test("warns when refresh token issue time is unknown", () => {
    const health = checkRefreshTokenHealth(account({ refresh_token_issued_at: null }), now);
    expect(health.status).toBe("warning");
    expect(health.requiresReauth).toBe(false);
  });

  test("warns near expiration", () => {
    const issuedAt = now - 84 * 24 * 60 * 60 * 1000;
    const health = checkRefreshTokenHealth(account({ refresh_token_issued_at: issuedAt }), now);
    expect(health.status).toBe("warning");
    expect(health.requiresReauth).toBe(false);
  });

  test("marks expired tokens as requiring reauth", () => {
    const issuedAt = now - 91 * 24 * 60 * 60 * 1000;
    const health = checkRefreshTokenHealth(account({ refresh_token_issued_at: issuedAt }), now);
    expect(health.status).toBe("expired");
    expect(health.requiresReauth).toBe(true);
  });

  test("missing refresh token requires reauth", () => {
    const health = checkRefreshTokenHealth(account({ refresh_token: null }), now);
    expect(health.status).toBe("no_refresh_token");
    expect(health.requiresReauth).toBe(true);
  });

  test("Claude Code OAuth token accounts do not require a refresh token", () => {
    const health = checkRefreshTokenHealth(
      account({
        auth_type: "claude_code_oauth_token",
        refresh_token: null,
        expires_at: now + 300 * 24 * 60 * 60 * 1000,
      }),
      now,
    );
    expect(health.status).toBe("healthy");
    expect(health.requiresReauth).toBe(false);
  });

  test("expired Claude Code OAuth token accounts require reauth", () => {
    const health = checkRefreshTokenHealth(
      account({
        auth_type: "claude_code_oauth_token",
        refresh_token: null,
        expires_at: now - 1,
      }),
      now,
    );
    expect(health.status).toBe("expired");
    expect(health.requiresReauth).toBe(true);
  });
});
