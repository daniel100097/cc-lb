import { describe, expect, test } from "bun:test";
import { dashboardPort, proxyPort, servicePorts } from "./ports";

describe("service ports", () => {
  test("uses separate dashboard and proxy defaults", () => {
    expect(servicePorts({})).toEqual({ dashboard: 8484, proxy: 8485 });
  });

  test("supports legacy PORT only as a dashboard fallback", () => {
    expect(dashboardPort({ PORT: "9000" })).toBe(9000);
    expect(dashboardPort({ PORT: "9000", DASHBOARD_PORT: "9001" })).toBe(9001);
    expect(proxyPort({ PORT: "9000" })).toBe(8485);
  });

  test("rejects invalid or overlapping listener ports", () => {
    expect(() => servicePorts({ DASHBOARD_PORT: "9000", PROXY_PORT: "9000" })).toThrow(
      "must be different",
    );
    expect(() => dashboardPort({ DASHBOARD_PORT: "0" })).toThrow("DASHBOARD_PORT");
    expect(() => proxyPort({ PROXY_PORT: "not-a-port" })).toThrow("PROXY_PORT");
  });
});
