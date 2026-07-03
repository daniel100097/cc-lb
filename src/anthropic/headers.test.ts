import { describe, expect, test } from "bun:test";
import { OAUTH_BETA_HEADER } from "./constants";
import { prepareRequestHeaders, sanitizeResponseHeaders } from "./headers";

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
