import { describe, expect, test } from "bun:test";
import { parseCredentials } from "./credentials";

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
});
