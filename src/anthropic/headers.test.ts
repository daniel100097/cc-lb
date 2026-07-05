import { describe, expect, test } from "bun:test";
import { OAUTH_BETA_HEADER } from "./constants";
import { DEVICE_ID_HEADER, FORWARDED_HEADERS, prepareRequestHeaders, sanitizeResponseHeaders } from "./headers";

describe("Anthropic headers", () => {
  test("strips client credentials and injects OAuth bearer token", () => {
    const headers = prepareRequestHeaders(
      new Headers({
        authorization: "Bearer client",
        "x-api-key": "client-key",
        host: "localhost",
        "anthropic-beta": "feature-a",
      }),
      "server-token",
    );

    expect(headers.get("authorization")).toBe("Bearer server-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("anthropic-beta")).toContain("feature-a");
    expect(headers.get("anthropic-beta")).toContain(OAUTH_BETA_HEADER);
  });

  test("does not duplicate oauth beta header", () => {
    const headers = prepareRequestHeaders(new Headers({ "anthropic-beta": OAUTH_BETA_HEADER }), "token");
    expect(headers.get("anthropic-beta")?.split(OAUTH_BETA_HEADER).length).toBe(2);
  });

  test("does not add outbound device id when the incoming request has none", () => {
    const headers = prepareRequestHeaders(new Headers(), "token", "account-device");
    expect(headers.get(DEVICE_ID_HEADER)).toBeNull();
  });

  test("overrides outbound device id only when the incoming request already has one", () => {
    const preserved = prepareRequestHeaders(new Headers({ [DEVICE_ID_HEADER]: "client-device" }), "token");
    expect(preserved.get(DEVICE_ID_HEADER)).toBe("client-device");

    const overridden = prepareRequestHeaders(new Headers({ [DEVICE_ID_HEADER]: "client-device" }), "token", "account-device");
    expect(overridden.get(DEVICE_ID_HEADER)).toBe("account-device");
  });

  test("replaces the client user-agent when an override is set", () => {
    const headers = prepareRequestHeaders(
      new Headers({ "user-agent": "claude-cli/1.0.0 (external, cli)" }),
      "token",
      null,
      "claude-cli/2.0.14 (external, cli)",
    );
    expect(headers.get("user-agent")).toBe("claude-cli/2.0.14 (external, cli)");
  });

  test("passes the client user-agent through when the override is empty or blank", () => {
    const incoming = new Headers({ "user-agent": "claude-cli/1.0.0 (external, cli)" });
    expect(prepareRequestHeaders(incoming, "token").get("user-agent")).toBe("claude-cli/1.0.0 (external, cli)");
    expect(prepareRequestHeaders(incoming, "token", null, "").get("user-agent")).toBe("claude-cli/1.0.0 (external, cli)");
    expect(prepareRequestHeaders(incoming, "token", null, "   ").get("user-agent")).toBe("claude-cli/1.0.0 (external, cli)");
  });

  test("strips forwarded headers only when enabled", () => {
    const incoming = () =>
      new Headers({
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-proto": "https",
        "x-real-ip": "203.0.113.7",
        via: "1.1 nginx",
        forwarded: "for=203.0.113.7",
        "content-type": "application/json",
      });

    const kept = prepareRequestHeaders(incoming(), "token");
    expect(kept.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(kept.get("via")).toBe("1.1 nginx");

    const stripped = prepareRequestHeaders(incoming(), "token", null, null, true);
    for (const header of FORWARDED_HEADERS) {
      expect(stripped.get(header)).toBeNull();
    }
    expect(stripped.get("content-type")).toBe("application/json");
  });

  test("sanitizes decompression-sensitive response headers", () => {
    const headers = sanitizeResponseHeaders(
      new Headers({
        "content-encoding": "gzip",
        "content-length": "100",
        "transfer-encoding": "chunked",
        "x-request-id": "abc",
      }),
    );

    expect(headers.get("content-encoding")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
    expect(headers.get("x-request-id")).toBe("abc");
  });
});
