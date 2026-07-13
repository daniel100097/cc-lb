import { describe, expect, test } from "bun:test";
import { OAUTH_BETA_HEADER } from "./constants";
import {
  CLIENT_IP_HEADER,
  DEVICE_ID_HEADER,
  FORWARDED_HEADERS,
  prepareRequestHeaders,
  sanitizeResponseHeaders,
} from "./headers";

describe("Anthropic headers", () => {
  test("strips client credentials and injects OAuth bearer token", () => {
    const headers = prepareRequestHeaders(
      new Headers({
        authorization: "Bearer client",
        "x-api-key": "client-key",
        host: "localhost",
        connection: "keep-alive",
        "anthropic-beta": "feature-a",
      }),
      "server-token",
    );

    expect(headers.get("authorization")).toBe("Bearer server-token");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("host")).toBeNull();
    expect(headers.get("connection")).toBe("close");
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

  test("never forwards an unsynchronized client device id", () => {
    const stripped = prepareRequestHeaders(new Headers({ [DEVICE_ID_HEADER]: "client-device" }), "token");
    expect(stripped.get(DEVICE_ID_HEADER)).toBeNull();

    const rewritten = prepareRequestHeaders(new Headers({ [DEVICE_ID_HEADER]: "client-device" }), "token", "account-device");
    expect(rewritten.get(DEVICE_ID_HEADER)).toBe("account-device");
  });

  test("passes the validated client user-agent through unchanged", () => {
    const incoming = new Headers({ "user-agent": "claude-cli/1.0.0 (external, cli)" });
    expect(prepareRequestHeaders(incoming, "token").get("user-agent")).toBe("claude-cli/1.0.0 (external, cli)");
  });

  test("rewrites client-ip only when the client sent the field", () => {
    const rewritten = prepareRequestHeaders(
      new Headers({ [CLIENT_IP_HEADER]: "198.51.100.20" }),
      "token",
      null,
      false,
      "203.0.113.40",
    );
    expect(rewritten.get(CLIENT_IP_HEADER)).toBe("203.0.113.40");

    const rewrittenWhileStrippingForwarded = prepareRequestHeaders(
      new Headers({ [CLIENT_IP_HEADER]: "198.51.100.20", "x-forwarded-for": "198.51.100.20" }),
      "token",
      null,
      true,
      "203.0.113.40",
    );
    expect(rewrittenWhileStrippingForwarded.get(CLIENT_IP_HEADER)).toBe("203.0.113.40");
    expect(rewrittenWhileStrippingForwarded.get("x-forwarded-for")).toBeNull();

    const absent = prepareRequestHeaders(new Headers(), "token", null, false, "203.0.113.40");
    expect(absent.get(CLIENT_IP_HEADER)).toBeNull();

    const unresolved = prepareRequestHeaders(
      new Headers({ [CLIENT_IP_HEADER]: "198.51.100.20" }),
      "token",
    );
    expect(unresolved.get(CLIENT_IP_HEADER)).toBeNull();
  });

  test("strips forwarded headers only when enabled", () => {
    const incoming = () =>
      new Headers({
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-proto": "https",
        "x-real-ip": "203.0.113.7",
        [CLIENT_IP_HEADER]: "203.0.113.7",
        via: "1.1 nginx",
        forwarded: "for=203.0.113.7",
        "content-type": "application/json",
      });

    const kept = prepareRequestHeaders(incoming(), "token");
    expect(kept.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(kept.get("via")).toBe("1.1 nginx");

    const stripped = prepareRequestHeaders(incoming(), "token", null, true);
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
