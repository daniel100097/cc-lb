import { describe, expect, test } from "bun:test";
import { maskProxyUrl, parseEgressProxyUrl, proxyEnvVars, proxyFetchInit } from "./egress-proxy";

describe("egress proxy URLs", () => {
  test("normalizes accepted http and https proxies", () => {
    expect(parseEgressProxyUrl("http://127.0.0.1:8888")).toBe("http://127.0.0.1:8888/");
    expect(parseEgressProxyUrl("  https://proxy.example.com  ")).toBe("https://proxy.example.com/");
    expect(parseEgressProxyUrl("http://user:pass@10.0.0.5:3128/")).toBe("http://user:pass@10.0.0.5:3128/");
  });

  test("rejects unsupported schemes and non-proxy URL shapes", () => {
    expect(() => parseEgressProxyUrl("")).toThrow("required");
    expect(() => parseEgressProxyUrl("127.0.0.1:8888")).toThrow("full URL");
    expect(() => parseEgressProxyUrl("socks5://127.0.0.1:1080")).toThrow("SOCKS");
    expect(() => parseEgressProxyUrl("http://127.0.0.1:8888/path")).toThrow("path");
    expect(() => parseEgressProxyUrl("http://127.0.0.1:8888/?a=1")).toThrow("query string");
  });

  test("masks the password for display", () => {
    expect(maskProxyUrl("http://user:hunter2@10.0.0.5:3128/")).toBe("http://user:***@10.0.0.5:3128/");
    expect(maskProxyUrl("http://10.0.0.5:3128/")).toBe("http://10.0.0.5:3128/");
    expect(maskProxyUrl("not a url")).toBe("not a url");
  });

  test("leaves direct traffic untouched and proxies everything else", () => {
    expect(proxyFetchInit(null)).toEqual({});
    expect(proxyEnvVars(null)).toEqual({});

    expect(proxyFetchInit("http://127.0.0.1:8888/")).toEqual({ proxy: "http://127.0.0.1:8888/" });
    expect(proxyEnvVars("http://127.0.0.1:8888/")).toEqual({
      HTTP_PROXY: "http://127.0.0.1:8888/",
      HTTPS_PROXY: "http://127.0.0.1:8888/",
      http_proxy: "http://127.0.0.1:8888/",
      https_proxy: "http://127.0.0.1:8888/",
    });
  });
});
