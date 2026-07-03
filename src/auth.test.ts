import { afterEach, describe, expect, test } from "bun:test";
import {
  handleAuthRoute,
  isDashboardAuthenticated,
  isDashboardAuthEnabled,
  loginResponse,
} from "./auth";

const originalPassword = process.env.DASHBOARD_PASSWORD;

afterEach(() => {
  if (originalPassword === undefined) {
    delete process.env.DASHBOARD_PASSWORD;
  } else {
    process.env.DASHBOARD_PASSWORD = originalPassword;
  }
});

describe("dashboard auth", () => {
  test("is disabled when DASHBOARD_PASSWORD is unset", () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect(isDashboardAuthEnabled()).toBe(false);
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test"))).toBe(true);
  });

  test("accepts bearer password when enabled", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    expect(isDashboardAuthEnabled()).toBe(true);
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test"))).toBe(false);
    expect(
      isDashboardAuthenticated(
        new Request("http://cc-lb.test", {
          headers: { authorization: "Bearer secret" },
        }),
      ),
    ).toBe(true);
  });

  test("login sets a session cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    const response = await handleAuthRoute(
      new Request("http://cc-lb.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password: "secret" }),
      }),
      new URL("http://cc-lb.test/api/auth/login"),
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie")).toContain("cc_lb_session=");
  });

  test("unauthenticated SPA requests receive login page", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    const response = loginResponse(new URL("http://cc-lb.test/"), false);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
