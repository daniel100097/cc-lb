import { afterEach, describe, expect, test } from "bun:test";
import {
  handleAuthRoute,
  isDashboardAuthenticated,
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
  test.each([undefined, ""])("requires the default password when DASHBOARD_PASSWORD is %s", async (password) => {
    if (password === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = password;
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test"))).toBe(false);
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test", {
      headers: { authorization: "Bearer changeme" },
    }))).toBe(true);
    const response = await login("changeme");
    expect(response?.status).toBe(200);
    const statusUrl = new URL("http://cc-lb.test/api/auth/status");
    const status = await handleAuthRoute(new Request(statusUrl), statusUrl);
    expect(await status?.json()).toEqual({ enabled: true, authenticated: false });
  });

  test("an ENV override replaces the default password for bearer and basic authentication", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test"))).toBe(false);
    expect(
      isDashboardAuthenticated(
        new Request("http://cc-lb.test", {
          headers: { authorization: "Bearer secret" },
        }),
      ),
    ).toBe(true);
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test", {
      headers: { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` },
    }))).toBe(true);
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test", {
      headers: { authorization: "Bearer changeme" },
    }))).toBe(false);
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
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
    const cookie = response?.headers.get("set-cookie")?.split(";")[0] ?? "";
    const authenticatedRequest = new Request("http://cc-lb.test", { headers: { cookie } });
    expect(isDashboardAuthenticated(authenticatedRequest)).toBe(true);
    process.env.DASHBOARD_PASSWORD = "new-secret";
    expect(isDashboardAuthenticated(authenticatedRequest)).toBe(false);
  });

  test("rejects incorrect, default, empty, and malformed login submissions with a visible error", async () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    for (const password of ["wrong", "changeme", ""]) {
      const response = await login(password);
      expect(response?.status).toBe(401);
      expect(response?.headers.has("set-cookie")).toBe(false);
      expect(await response?.text()).toContain("Invalid password.");
    }
    const url = new URL("http://cc-lb.test/api/auth/login");
    const malformed = await handleAuthRoute(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }), url);
    expect(malformed?.status).toBe(401);
  });

  test("rejects malformed cookies without throwing", () => {
    expect(isDashboardAuthenticated(new Request("http://cc-lb.test", {
      headers: { cookie: "cc_lb_session=%ZZ" },
    }))).toBe(false);
  });

  test("browser login redirects to the dashboard and logout removes the cookie", async () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    const response = await login("secret", "text/html");
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe("/");
    const url = new URL("http://cc-lb.test/api/auth/logout");
    const logout = await handleAuthRoute(new Request(url, { method: "POST" }), url);
    expect(logout?.status).toBe(204);
    expect(logout?.headers.get("set-cookie")).toContain("cc_lb_session=; Path=/; Max-Age=0;");
  });

  test("unauthenticated SPA requests receive login page", () => {
    process.env.DASHBOARD_PASSWORD = "secret";
    const response = loginResponse(new URL("http://cc-lb.test/"), false);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});

function login(password: string, accept = "application/json") {
  const url = new URL("http://cc-lb.test/api/auth/login");
  return handleAuthRoute(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify({ password }),
  }), url);
}
